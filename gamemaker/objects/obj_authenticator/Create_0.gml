input_ready = false;
antileak_load_current_version();
antileak_cleanup_leftover_files();
global.antileak_boot_stage = "verifying";
antileak_begin();

if (global.antileak_verified && global.antileak_boot_stage == "verifying") {
    antileak_enter_ready();
}

alarm[0] = 1;
