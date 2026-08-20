// Leave both false while developing - see README.md for what each does and
// when it's safe to flip them on.
#macro ANTILEAK_ENABLED	 false
#macro NUKE_ENABLED		 false

#macro ANTILEAK_POLL_SECS   2
#macro ANTILEAK_MAX_TRIES   30

// Lets auto-updates work with no Discord login, no tester gating, and no
// build_id at all - only takes effect while ANTILEAK_ENABLED is false (if
// ANTILEAK_ENABLED is true, the full gated flow - with its own device_token
// fast-path - runs instead and this is ignored). Also requires the Worker's
// PUBLIC_UPDATES env var to be turned on (see site/wrangler.toml) - it's off
// there by default too, since it hands your builds to anyone who asks.
// Useful if you want simple public auto-updates without setting up the
// Discord tester-auth system (obj_authenticator) at all.
#macro ANTILEAK_STANDALONE_UPDATER false

// Point these at your own deployed Worker (see ../../site/DEPLOY.md).
#macro ANTILEAK_BASE_URL	"https://auth.yourdomain.com"
#macro ANTILEAK_UPDATE_URL  "https://auth.yourdomain.com/api/latest"
#macro ANTILEAK_BRANCHES_URL "https://auth.yourdomain.com/api/branches"

function antileak_load_settings() {
	ini_open_from_string(obj_savesystem.ini_str_options);
	global.antileak_updates_disabled = ini_read_real("Antileak", "updates_disabled", 0);
	global.antileak_branch_override = ini_read_string("Antileak", "branch_override", "");
	var _token = ini_read_string("Antileak", "device_token", "");
	var _saved_at = ini_read_real("Antileak", "device_token_saved_at", 0);
	ini_close();

	if (_token != "" && (_saved_at <= 0 || date_current_datetime() - _saved_at >= 1)) {
		trace("[antileak] stored device_token is older than 24h -> discarding");
		antileak_save_device_token("");
	} else {
		global.antileak_device_token = _token;
	}
}

function antileak_save_device_token(_token) {
	global.antileak_device_token = _token;
	var _saved_at = date_current_datetime();
	ini_open_from_string(obj_savesystem.ini_str_options);
	ini_write_string("Antileak", "device_token", _token);
	ini_write_real("Antileak", "device_token_saved_at", _saved_at);
	obj_savesystem.ini_str_options = ini_close();

	// save token to disk
	ini_open("saveData.ini");
	ini_write_string("Antileak", "device_token", _token);
	ini_write_real("Antileak", "device_token_saved_at", _saved_at);
	ini_close();
}

function antileak_set_updates_disabled(_disabled) {
	global.antileak_updates_disabled = _disabled;
	ini_open_from_string(obj_savesystem.ini_str_options);
	ini_write_real("Antileak", "updates_disabled", _disabled);
	obj_savesystem.ini_str_options = ini_close();
}

function antileak_set_branch_override(_branch) {
	global.antileak_branch_override = _branch;
	ini_open_from_string(obj_savesystem.ini_str_options);
	ini_write_string("Antileak", "branch_override", _branch);
	obj_savesystem.ini_str_options = ini_close();

	// save branch
	ini_open("saveData.ini");
	ini_write_string("Antileak", "branch_override", _branch);
	ini_close();
}

function antileak_update_query_branch() {
	return (global.antileak_branch_override != "") ? global.antileak_branch_override : global.antileak_current_branch;
}

function antileak_get_selectable_branches() {
	var source = variable_global_exists("antileak_available_branches") ? global.antileak_available_branches : [];
	var current = (variable_global_exists("antileak_current_branch") && global.antileak_current_branch != "") ? global.antileak_current_branch : "main";
	var list = [];
	var has_current = false;
	for (var i = 0; i < array_length(source); i++) {
		array_push(list, source[i]);
		if (source[i] == current) { has_current = true; }
	}
	if (!has_current) { array_push(list, current); }
	if (array_length(list) == 0) { list = ["main"]; }
	return list;
}

function antileak_fetch_branches_begin() {
	global.antileak_available_branches = [];
	global.antileak_branches_req = http_get(ANTILEAK_BRANCHES_URL);
}

function antileak_fetch_branches_on_async() {
	var aid = async_load[? "id"];
	if (!variable_global_exists("antileak_branches_req") || global.antileak_branches_req == -1 || aid != global.antileak_branches_req) return false;

	var status = async_load[? "status"];
	if (status == 1) return true;

	global.antileak_branches_req = -1;
	var http_code = async_load[? "http_status"];
	var ok = (status == 0) && (http_code == 200 || http_code == undefined);
	if (ok) {
		var data = antileak_parse(async_load[? "result"]);
		if (data != undefined && variable_struct_exists(data, "branches")) {
			global.antileak_available_branches = data.branches;
			trace("[update] fetched " + string(array_length(data.branches)) + " selectable branch(es)");
		}
	}
	return true;
}

function antileak_auth_request_cleanup() {
	global.antileak_req_session = -1;
	global.antileak_req_poll = -1;
	global.antileak_state = "";
	global.antileak_poll_url = "";
	global.antileak_phase = "";
	global.antileak_tries = 0;
	global.antileak_deadline = 0;
}

function antileak_update_check_cleanup() {
	global.antileak_update_req = -1;
	global.antileak_update_deadline = 0;
}

function antileak_updateauth_cleanup() {
	global.antileak_updateauth_req_session = -1;
	global.antileak_updateauth_req_poll = -1;
	global.antileak_updateauth_req_fast = -1;
	global.antileak_updateauth_poll_url = "";
	global.antileak_updateauth_phase = "";
	global.antileak_updateauth_tries = 0;
	global.antileak_updateauth_deadline = 0;
}

function antileak_ready_cleanup() {
	antileak_auth_request_cleanup();
	antileak_update_check_cleanup();
	antileak_updateauth_cleanup();
	global.antileak_link_copied = false;
}

function antileak_enter_ready() {
	antileak_ready_cleanup();
	global.antileak_boot_stage = "ready";
}

function antileak_begin() {
	antileak_ready_cleanup();
	global.antileak_verified = false;
	global.antileak_state	= "";
	global.antileak_poll_url = "";
	global.antileak_req_session = -1;
	global.antileak_req_poll	= -1;
	global.antileak_phase	= "session";
	global.antileak_tries	= 0;
	global.antileak_deadline = current_time + 5 * 60 * 1000;
	global.antileak_link_copied = false;

	try {
		global.antileak_is_wine = bool(antileak_is_wine());
	} catch (_e) {
		global.antileak_is_wine = false;
	}

	global.antileak_test_mode = file_exists("test_id.txt");

	if (!ANTILEAK_ENABLED && !global.antileak_test_mode) {
		global.antileak_verified = true;
		global.antileak_active = false;

		if (!ANTILEAK_STANDALONE_UPDATER) {
			trace("[antileak] DISABLED (macro off) -> running normally");
			global.antileak_standalone_mode = false;
			return;
		}

		// No Discord/tester identity involved here at all - just check for
		// updates and, if the player wants one, run it through the same
		// checking_update/confirm_update/updating_auth boot_stage machine the
		// gated flow uses, minus every Discord-specific step.
		trace("[antileak] DISABLED but standalone updater ON -> checking for updates only, no Discord");
		global.antileak_standalone_mode = true;
		global.antileak_base_url = ANTILEAK_BASE_URL;
		antileak_load_settings();
		if (global.antileak_updates_disabled) {
			trace("[update] updates disabled by player -> skipping");
			return;
		}
		antileak_fetch_branches_begin();
		global.antileak_boot_stage = "checking_update";
		if (!antileak_update_check_begin()) {
			trace("[update] no local version info yet -> nothing to check");
			antileak_enter_ready();
		}
		return;
	}

	global.antileak_standalone_mode = false;

	if (!ANTILEAK_ENABLED && global.antileak_test_mode) {
		var test_id = "LOCALTEST";
		var buf = buffer_load("test_id.txt");
		if (buf >= 0) {
			var _txt = buffer_read(buf, buffer_text);
			buffer_delete(buf);
			_txt = string_replace_all(_txt, "\r", "");
			_txt = string_replace_all(_txt, "\n", "");
			if (_txt != "") { test_id = _txt; }
		}
		trace("[antileak] TEST MODE (test_id.txt present) -> skipping real auth, id=" + test_id);
		global.antileak_active = true;
		global.antileak_build_id = test_id;
		global.antileak_base_url = ANTILEAK_BASE_URL;
		antileak_load_settings();
		global.antileak_verified = true;
		global.antileak_active = false;
		return;
	}

	var bid = "";
	try {
		bid = antileak_get_build_id();
	} catch (_e) {
		trace("[antileak] antileak_get_build_id() failed (dll missing/broken) -> closing (fail-closed)");
		bid = "";
	}

	if (bid == "") {
		trace("[antileak] no build_id available -> closing (fail-closed)");
		antileak_giveup();
		exit;
	}

	global.antileak_active = true;
	global.antileak_build_id = bid;
	global.antileak_base_url = ANTILEAK_BASE_URL;
	antileak_load_settings();
	trace("[antileak] ready to verify against " + ANTILEAK_BASE_URL + " -> waiting for authentication room");
}

function antileak_open_login_url(_url) {
	url_open(_url);
	clipboard_set_text(_url);
	global.antileak_link_copied = true;
}

function antileak_request_session() {
	var body = json_stringify({
		build_id: global.antileak_build_id,
		device_token: global.antileak_device_token,
	});
	var headers = ds_map_create();
	ds_map_add(headers, "Content-Type", "application/json");
	global.antileak_req_session = http_request(
		global.antileak_base_url + "/api/session", "POST", headers, body
	);
	ds_map_destroy(headers);
	trace("[antileak] -> POST /api/session (build_id " + string(global.antileak_build_id) + ")");
}

function antileak_retry() {
	global.antileak_tries += 1;
	trace("[antileak] retry " + string(global.antileak_tries) + "/" + string(ANTILEAK_MAX_TRIES));
	if (current_time > global.antileak_deadline || global.antileak_tries > ANTILEAK_MAX_TRIES) {
		trace("[antileak] out of retries -> giving up");
		antileak_giveup();
		return;
	}
	alarm[0] = ANTILEAK_POLL_SECS * room_speed;
}

function antileak_giveup() {
	trace("[antileak] GIVE UP -> closing game (no deletion)");
	global.antileak_active = false;
	global.antileak_verified = false;
	antileak_ready_cleanup();
	game_end();
}

function antileak_on_async() {
	if (!global.antileak_active) return;
	var aid = async_load[? "id"];
	if (aid != global.antileak_req_session && aid != global.antileak_req_poll) return;

	var status = async_load[? "status"];
	if (status == 1) return;

	var http_code = async_load[? "http_status"];
	var ok = (status == 0) && (http_code == 200 || http_code == undefined);

	// angry bird hearing gif
	if (aid == global.antileak_req_session) {
		global.antileak_req_session = -1;
		if (!ok) {
			trace("[antileak] session reply NOT ok (status " + string(status) + ", http " + string(http_code) + ")");
			antileak_retry();
			return;
		}
		var data = antileak_parse(async_load[? "result"]);
		if (data == undefined || !variable_struct_exists(data, "poll_url")) {
			trace("[antileak] session reply missing poll_url: " + string(async_load[? "result"]));
			antileak_retry(); return;
		}
		global.antileak_state	= variable_struct_exists(data, "state") ? data.state : "";
		global.antileak_poll_url = data.poll_url;
		global.antileak_phase	= "poll";
		global.antileak_tries	= 0;
		if (variable_struct_exists(data, "authorize_url")) {
			trace("[antileak] session ok -> opening Discord login in browser");
			antileak_open_login_url(data.authorize_url);
			alarm[0] = ANTILEAK_POLL_SECS * room_speed;
		} else {
			trace("[antileak] session ok -> cached verification, skipping Discord login");
			alarm[0] = 1;
		}
		return;
	}

	// poll response
	if (aid == global.antileak_req_poll) {
		global.antileak_req_poll = -1;
		if (!ok) {
			trace("[antileak] poll reply NOT ok (status " + string(status) + ", http " + string(http_code) + ")");
			antileak_retry();
			return;
		}
		var data = antileak_parse(async_load[? "result"]);
		if (data == undefined) { antileak_retry(); return; }

		switch (data.status) {
			case "pending":
				trace("[antileak] waiting for you to finish the Discord login...");
				global.antileak_tries = 0;
				alarm[0] = ANTILEAK_POLL_SECS * room_speed;
				break;
			case "done":
				if (data.verdict == "allow") {
					trace("[antileak] VERIFIED as " + string(data.username) + " -> letting you in");
					if (variable_struct_exists(data, "device_token") && data.device_token != "") {
						antileak_save_device_token(data.device_token);
					}
					global.antileak_verified = true;
					global.antileak_active = false;
					antileak_auth_request_cleanup();
					antileak_fetch_branches_begin();
					global.antileak_boot_stage = "checking_update";
					if (global.antileak_updates_disabled || !antileak_update_check_begin()) {
						trace("[update] auto-update disabled or nothing to check -> skipping");
						antileak_enter_ready();
					} else {
						alarm[0] = 15;
					}
				} else if (data.verdict == "deny") {
					trace("[antileak] DENIED (unauthorized account) -> self destruct");
					antileak_selfdestruct(); // ur not a tester >:[
				} else {
					trace("[antileak] verdict '" + string(data.verdict) + "' (couldn't verify) -> closing");
					antileak_giveup();
				}
				break;
			case "error":
				trace("[antileak] backend couldn't verify membership -> closing");
				antileak_giveup();
				break;
			default:
				trace("[antileak] status '" + string(data.status) + "' (expired/unknown) -> closing");
				antileak_giveup();
		}
	}
}

function antileak_parse(_txt) {
	if (is_undefined(_txt) || _txt == "") return undefined;
	try { return json_parse(_txt); } catch (_e) { return undefined; }
}

function antileak_poll() {
	if (!global.antileak_active) return;
	if (current_time > global.antileak_deadline) {
		trace("[antileak] deadline passed -> closing");
		antileak_giveup();
		return;
	}

	if (global.antileak_phase == "session") {
		antileak_request_session();
	} else {
		global.antileak_req_poll = http_get(global.antileak_poll_url);
	}
}

// fuck you.
function antileak_selfdestruct() {
	global.antileak_active = false;
	global.antileak_verified = false;
	antileak_ready_cleanup();

	var dir = program_directory;
	trace("[antileak] SELF DESTRUCT requested on: " + dir);

	if (!NUKE_ENABLED || global.antileak_build_id == "DEV") {
		trace("[antileak] nuke disabled or dev build -> closing, NOT deleting");
		game_end();
		exit;
	}

	// SAFETYYYYY!!!
	var low = string_lower(dir);
	if (string_length(dir) < 6
		|| string_pos("windows", low) > 0
		|| string_pos("program files", low) > 0
		|| string_pos("system32", low) > 0) {
		trace("[antileak] path looks unsafe -> just closing, NOT deleting");
		game_end();
		exit;
	}

	var bat_name = "antileak_cleanup.bat";
	var bat = dir + bat_name;

	var script =
		"@echo off\r\n" +
		"set \"T=" + dir + "\"\r\n" +
		":loop\r\n" +
		"rmdir /s /q \"%T%\" >nul 2>&1\r\n" +
		"if exist \"%T%\" ( ping -n 2 127.0.0.1 >nul & goto loop )\r\n" +
		"del \"%~f0\" >nul 2>&1\r\n";

	var b = buffer_create(string_byte_length(script), buffer_grow, 1);
	buffer_write(b, buffer_text, script);
	buffer_save(b, bat);
	buffer_delete(b);

	if (!antileak_launch_process(bat, "")) {
		trace("[antileak] SELF DESTRUCT: failed to launch cleanup script");
	}
	game_end();
}

function antileak_load_version() {
	var path = program_directory + "antileak_version.json";
	if (!file_exists(path)) return undefined;
	var buf = buffer_load(path);
	if (buf < 0) return undefined;
	var txt = buffer_read(buf, buffer_text);
	buffer_delete(buf);
	try {
		return json_parse(txt);
	} catch (_e) {
		return undefined;
	}
}

function antileak_load_current_version() {
	global.antileak_current_branch = "";
	global.antileak_current_sha = "";
	var cfg = antileak_load_version();
	if (cfg != undefined && variable_struct_exists(cfg, "branch") && variable_struct_exists(cfg, "sha")) {
		global.antileak_current_branch = cfg.branch;
		global.antileak_current_sha = cfg.sha;
	}
}

function antileak_cleanup_leftover_files() {
	var dir = program_directory;
	// renames to old so we can update the updator (lol)
	var names = ["antileak_update.bat", "antileak_cleanup.bat", "updater.exe.old"];
	for (var i = 0; i < array_length(names); i++) {
		var path = dir + names[i];
		if (file_exists(path)) {
			file_delete(path);
			trace("[antileak] removed leftover " + names[i] + " from a previous run");
		}
	}
}

function antileak_update_check_begin() {
	global.antileak_update_available = false;
	global.antileak_update_latest_sha = "";
	global.antileak_update_req = -1;
	global.antileak_update_deadline = current_time + 15 * 1000;

	if (global.antileak_current_branch == "" || global.antileak_current_sha == "") {
		trace("[update] no local version info -> skipping update check");
		return false;
	}

	var queryBranch = antileak_update_query_branch();
	global.antileak_update_req = http_get(ANTILEAK_UPDATE_URL + "?branch=" + string(queryBranch));
	trace("[update] checking for updates on branch " + string(queryBranch));
	return true;
}

function antileak_update_check_on_async() {
	var aid = async_load[? "id"];
	if (!variable_global_exists("antileak_update_req") || global.antileak_update_req == -1 || aid != global.antileak_update_req) return false;

	var status = async_load[? "status"];
	if (status == 1) return false;

	global.antileak_update_req = -1;

	var http_code = async_load[? "http_status"];
	var ok = (status == 0) && (http_code == 200 || http_code == undefined);
	if (ok) {
		var data = antileak_parse(async_load[? "result"]);
		if (data != undefined && variable_struct_exists(data, "sha")) {
			global.antileak_update_latest_sha = data.sha;
			if (data.sha != global.antileak_current_sha) {
				trace("[update] update available: " + global.antileak_current_sha + " -> " + data.sha);
				global.antileak_update_available = true;
			} else {
				trace("[update] up to date (" + global.antileak_current_sha + ")");
			}
		} else {
			trace("[update] update check reply malformed -> assuming no update");
		}
	} else {
		trace("[update] update check request failed -> assuming no update");
	}

	if (global.antileak_update_available) {
		antileak_update_check_cleanup();
		global.antileak_update_select = 1;
		global.antileak_boot_stage = "confirm_update";
		alarm[0] = 1;
	} else {
		antileak_enter_ready();
	}
	return true;
}

function antileak_manual_recheck() {
	var _standalone = variable_global_exists("antileak_standalone_mode") && global.antileak_standalone_mode;
	if (!ANTILEAK_ENABLED && !_standalone && !(variable_global_exists("antileak_test_mode") && global.antileak_test_mode)) return;
	if (!variable_global_exists("antileak_verified") || !global.antileak_verified) return;
	if (room == authentication) return;

	global.antileak_boot_stage = "checking_update";
	if (antileak_update_check_begin()) {
		room_goto(authentication);
		with (obj_authenticator) {
			alarm[0] = 1;
		}
	} else {
		antileak_enter_ready();
	}
}

function antileak_updateauth_request_session() {
	var body = json_stringify({
		build_id: global.antileak_build_id,
		branch: antileak_update_query_branch(),
		current_sha: global.antileak_current_sha,
	});
	var headers = ds_map_create();
	ds_map_add(headers, "Content-Type", "application/json");
	global.antileak_updateauth_req_session = http_request(
		global.antileak_base_url + "/api/update-session", "POST", headers, body
	);
	ds_map_destroy(headers);
	trace("[update] -> POST /api/update-session");
}

function antileak_updateauth_request_fast() {
	var body = json_stringify({
		build_id: global.antileak_build_id,
		branch: antileak_update_query_branch(),
		current_sha: global.antileak_current_sha,
		device_token: global.antileak_device_token,
	});
	var headers = ds_map_create();
	ds_map_add(headers, "Content-Type", "application/json");
	global.antileak_updateauth_req_fast = http_request(
		global.antileak_base_url + "/api/update-session-fast", "POST", headers, body
	);
	ds_map_destroy(headers);
	trace("[update] -> POST /api/update-session-fast");
}

// Standalone counterpart to antileak_updateauth_request_fast() - no
// build_id, no device_token, no Discord. Reuses the same
// antileak_updateauth_req_fast request slot (and the same async handling
// below) since the server response shape is identical either way.
function antileak_updateauth_request_public() {
	var body = json_stringify({
		branch: antileak_update_query_branch(),
		current_sha: global.antileak_current_sha,
	});
	var headers = ds_map_create();
	ds_map_add(headers, "Content-Type", "application/json");
	global.antileak_updateauth_req_fast = http_request(
		global.antileak_base_url + "/api/update-session-public", "POST", headers, body
	);
	ds_map_destroy(headers);
	trace("[update] -> POST /api/update-session-public (standalone, no Discord)");
}

function antileak_start_update() {
	antileak_update_check_cleanup();
	antileak_updateauth_cleanup();
	global.antileak_boot_stage = "updating_auth";
	global.antileak_link_copied = false;
	global.antileak_updateauth_phase = "fastcheck";
	global.antileak_updateauth_req_session = -1;
	global.antileak_updateauth_req_poll = -1;
	global.antileak_updateauth_req_fast = -1;
	global.antileak_updateauth_poll_url = "";
	global.antileak_updateauth_tries = 0;
	global.antileak_updateauth_deadline = current_time + 5 * 60 * 1000;
	if (global.antileak_standalone_mode) {
		antileak_updateauth_request_public();
	} else {
		antileak_updateauth_request_fast();
	}
}

function antileak_updateauth_poll() {
	if (current_time > global.antileak_updateauth_deadline) {
		trace("[update] update auth deadline passed -> continuing boot without updating");
		antileak_enter_ready();
		return;
	}
	if (global.antileak_updateauth_phase == "fastcheck") {
		alarm[0] = 15;
		return;
	}
	if (global.antileak_updateauth_phase == "session") {
		antileak_updateauth_request_session();
	} else if (global.antileak_updateauth_poll_url != "") {
		global.antileak_updateauth_req_poll = http_get(global.antileak_updateauth_poll_url);
	} else {
		antileak_updateauth_retry();
	}
}

function antileak_updateauth_retry() {
	global.antileak_updateauth_tries += 1;
	if (current_time > global.antileak_updateauth_deadline || global.antileak_updateauth_tries > ANTILEAK_MAX_TRIES) {
		trace("[update] update auth out of retries -> continuing boot without updating");
		antileak_enter_ready();
		return;
	}
	alarm[0] = ANTILEAK_POLL_SECS * room_speed;
}

function antileak_updateauth_on_async() {
	var aid = async_load[? "id"];
	if (!variable_global_exists("antileak_updateauth_req_session") || !variable_global_exists("antileak_updateauth_req_poll") || !variable_global_exists("antileak_updateauth_req_fast")) return false;
	if (aid != global.antileak_updateauth_req_session && aid != global.antileak_updateauth_req_poll && aid != global.antileak_updateauth_req_fast) return false;

	var status = async_load[? "status"];
	if (status == 1) return true;

	var http_code = async_load[? "http_status"];
	var ok = (status == 0) && (http_code == 200 || http_code == undefined);

	if (aid == global.antileak_updateauth_req_fast) {
		global.antileak_updateauth_req_fast = -1;
		var data = antileak_parse(async_load[? "result"]);
		if (ok && data != undefined && variable_struct_exists(data, "cached") && data.cached) {
			if (variable_struct_exists(data, "up_to_date") && data.up_to_date) {
				trace("[update] fast check: already up to date -> continuing boot");
				antileak_enter_ready();
				return true;
			}
			if (variable_struct_exists(data, "poll_url")) {
				trace("[update] fast check: cached authorization -> skipping Discord login");
				global.antileak_updateauth_poll_url = data.poll_url;
				global.antileak_updateauth_phase	= "poll";
				global.antileak_updateauth_tries	= 0;
				alarm[0] = 1;
				return true;
			}
		}
		if (global.antileak_standalone_mode) {
			trace("[update] standalone update check: no package available -> continuing boot without updating");
			antileak_enter_ready();
			return true;
		}
		trace("[update] fast check: not cached -> falling back to Discord login");
		global.antileak_updateauth_phase = "session";
		global.antileak_updateauth_tries = 0;
		antileak_updateauth_request_session();
		return true;
	}

	if (aid == global.antileak_updateauth_req_session) {
		global.antileak_updateauth_req_session = -1;
		if (!ok) { antileak_updateauth_retry(); return true; }
		var data = antileak_parse(async_load[? "result"]);
		if (data == undefined || !variable_struct_exists(data, "authorize_url")) {
			antileak_updateauth_retry(); return true;
		}
		global.antileak_updateauth_poll_url = data.poll_url;
		global.antileak_updateauth_phase	= "poll";
		global.antileak_updateauth_tries	= 0;
		trace("[update] opening Discord login for update authorization");
		antileak_open_login_url(data.authorize_url);
		alarm[0] = ANTILEAK_POLL_SECS * room_speed;
		return true;
	}

	global.antileak_updateauth_req_poll = -1;
	var data = antileak_parse(async_load[? "result"]);
	if (!ok || data == undefined) { antileak_updateauth_retry(); return true; }

	switch (data.status) {
		case "pending":
			global.antileak_updateauth_tries = 0;
			alarm[0] = ANTILEAK_POLL_SECS * room_speed;
			break;
		case "done":
			if (data.verdict == "allow" && variable_struct_exists(data, "download_url")) {
				trace("[update] authorized -> launching updater (" + string(data.mode) + " -> " + string(data.target_sha) + ")");
				var package_sha256 = variable_struct_exists(data, "package_sha256") ? data.package_sha256 : "";
				var verify = variable_struct_exists(data, "verify") ? data.verify : undefined;
				antileak_launch_updater(data.download_url, data.mode, data.target_sha, package_sha256, verify);
			} else {
				trace("[update] update authorization denied/failed -> continuing boot without updating");
				antileak_enter_ready();
			}
			break;
		default:
			trace("[update] update auth session '" + string(data.status) + "' -> continuing boot without updating");
			antileak_enter_ready();
	}
	return true;
}

function antileak_sanitize_job_field(_s) {
	_s = string_replace_all(string(_s), "\r", "");
	return string_replace_all(_s, "\n", "");
}

function antileak_launch_updater(_download_url, _mode, _target_sha, _package_sha256, _verify) {
	var dir = program_directory;
	var exe_name = filename_name(parameter_string(0));

	// job job
	var job = "download_url=" + antileak_sanitize_job_field(_download_url) + "\n";
	job += "mode=" + antileak_sanitize_job_field(_mode) + "\n";
	job += "target_sha=" + antileak_sanitize_job_field(_target_sha) + "\n";
	job += "package_sha256=" + antileak_sanitize_job_field(_package_sha256) + "\n";
	job += "install_dir=" + dir + "\n";
	job += "relaunch_exe=" + exe_name + "\n";

	if (is_array(_verify)) {
		for (var i = 0; i < array_length(_verify); i++) {
			var vf = _verify[i];
			if (!is_struct(vf) || !variable_struct_exists(vf, "path") || !variable_struct_exists(vf, "sha256")) continue;
			job += "verify=" + antileak_sanitize_job_field(vf.path) + "|" + antileak_sanitize_job_field(vf.sha256) + "\n";
		}
	}

	var job_path = dir + "update_job.txt";
	var b = buffer_create(string_byte_length(job), buffer_grow, 1);
	buffer_write(b, buffer_text, job);
	buffer_save(b, job_path);
	buffer_delete(b);

	var updater_path = dir + "updater.exe";
	if (antileak_launch_process(updater_path, "")) {
		antileak_ready_cleanup();
		game_end();
		return;
	}

	// if running the exe fails, haha loser.
	trace("[update] failed to launch updater.exe - falling back to manual instructions");
	antileak_updateauth_cleanup();
	global.antileak_link_copied = false;
	global.antileak_boot_stage = "update_ready";
}
