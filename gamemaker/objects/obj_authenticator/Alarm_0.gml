switch (global.antileak_boot_stage) {
	case "verifying":
		if (room != authentication) {
			alarm[0] = 1;
			break;
		}
		antileak_poll();
		break;

	case "checking_update":
		if (current_time > global.antileak_update_deadline) {
			trace("[update] update check timed out -> assuming no update");
			antileak_enter_ready();
		} else {
			alarm[0] = 15;
		}
		break;

	case "updating_auth":
		antileak_updateauth_poll();
		break;

	case "confirm_update":
		if (room != authentication) {
			alarm[0] = 1;
			break;
		}
		if (!input_ready) {
			scr_initinput();
			if (!variable_global_exists("swapmode")) {
				global.swapmode = false;
			}
			input_ready = true;
		}
		scr_menu_getinput();
		if (-key_left2) {
			global.antileak_update_select = 0;
		} else if (key_right2) {
			global.antileak_update_select = 1;
		}
		if (key_jump) {
			if (global.antileak_update_select == 0) {
				antileak_start_update();
			} else {
				antileak_enter_ready();
			}
		}
		alarm[0] = 1;
		break;

	case "ready":
		if (room == authentication) {
			room_goto(Realtitlescreen);
			screen_apply_vsync();
		}
		break;
}
