input_ready = false;
antileak_load_current_version();
antileak_cleanup_leftover_files();
global.antileak_boot_stage = "verifying";
antileak_begin();
// antileak_begin() already advances boot_stage itself when the standalone
// updater kicks off a check (see scr_auth.gml) - only auto-shortcut to
// "ready" here if it left boot_stage untouched, so we don't clobber an
// update check that's already in flight.
if (global.antileak_verified && global.antileak_boot_stage == "verifying") {
	antileak_enter_ready();
}
alarm[0] = 1;
