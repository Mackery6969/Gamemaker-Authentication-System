if (!variable_global_exists("antileak_boot_stage")) exit;
if (room != authentication) exit;
if (global.antileak_boot_stage == "ready") exit;

draw_rectangle_color(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, c_black, c_black, c_black, c_black, false);

var _midW = SCREEN_WIDTH / 2;
var _midH = SCREEN_HEIGHT / 2;
draw_set_font(fnt_caption);
draw_set_halign(fa_center);
draw_set_valign(fa_middle);
draw_set_alpha(1);
draw_set_color(c_white);
switch (global.antileak_boot_stage)
{
	case "verifying":
		draw_text(_midW, _midH + 80, lang_get_value("antileak_verifying"));
		if (variable_global_exists("antileak_is_wine") && global.antileak_is_wine && global.antileak_link_copied) {
			draw_text(_midW, _midH + 110, lang_get_value("antileak_link_copied"));
		}
		break;
	case "checking_update":
		draw_text(_midW, _midH + 80, lang_get_value("antileak_checking_update"));
		break;
	case "confirm_update":
		draw_text(_midW, _midH + 50, lang_get_value("antileak_update_prompt"));
		draw_text(_midW, _midH + 80, lang_get_value("antileak_update_confirm"));
		var c1 = (global.antileak_update_select == 0) ? c_white : c_gray;
		var c2 = (global.antileak_update_select == 1) ? c_white : c_gray;
		draw_set_color(c1);
		draw_text(_midW - 100, _midH + 110, lang_get_value("option_yes"));
		draw_set_color(c2);
		draw_text(_midW + 100, _midH + 110, lang_get_value("option_no"));
		break;
	case "updating_auth":
		draw_text(_midW, _midH + 80, lang_get_value("antileak_updating_auth"));
		if (variable_global_exists("antileak_is_wine") && global.antileak_is_wine && global.antileak_link_copied) {
			draw_text(_midW, _midH + 110, lang_get_value("antileak_link_copied"));
		}
		break;
	case "update_ready":
		draw_text(_midW, _midH + 60, embed_value_string(lang_get_value_newline("antileak_update_ready"), [program_directory]));
		break;
}
draw_set_color(c_white);
