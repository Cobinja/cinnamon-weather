/*
 *
 *  Weather applet for Cinnamon
 *  - Displays a small weather information on the panel.
 *  - On click, gives a popup with details about the weather.
 *
 * Original Authors
 *	 ecyrbe <ecyrbe+spam@gmail.com>,
 *	 Timur Kristof <venemo@msn.com>,
 *	 Elad Alfassa <elad@fedoraproject.org>,
 *	 Simon Legner <Simon.Legner@gmail.com>,
 *	 Mark Benjamin <weather.gnome.Markie1@dfgh.net>
 *
 *
 * This file is part of cinnamon-weather.
 *
 * cinnamon-weather is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * cinnamon-weather is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with cinnamon-weather.  If not, see <http://www.gnu.org/licenses/>.
 */

//----------------------------------
//  imports
//----------------------------------

const Applet = imports.ui.applet;
const Cairo = imports.cairo;
const ExtensionSystem = imports.ui.extensionSystem;
const Gettext = imports.gettext;
const _ = Gettext.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Json = imports.gi.Json;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Soup = imports.gi.Soup;
const St = imports.gi.St;
const Util = imports.misc.util;

//----------------------------------------------------------------------
//
//  Constants
//
//----------------------------------------------------------------------

const UUID = 'weather@mockturtl';

const APPLET_ICON = "view-refresh-symbolic";
const APPLET_LABEL = "...";
const APPLET_TOOLTIP = "Click to open";

const ICON_PREFERENCES = 'system-run';

const GSETTINGS_SCHEMA = 'org.cinnamon.applets.' + UUID;

const COMMAND_CONFIGURE = "cinnamon-weather-settings";

// Conversion Factors
const WEATHER_CONV_MPH_IN_MPS = 2.23693629;
const WEATHER_CONV_KPH_IN_MPS = 3.6;
const WEATHER_CONV_KNOTS_IN_MPS = 1.94384449;

// Magic strings
const ELLIPSIS = '...';
const EN_DASH = '\u2013';

// Query
const QUERY_PARAMS = '?format=json&q=select ';
const QUERY_TABLE = 'weather.forecast';
const QUERY_VIEW = 'link,location,wind,atmosphere,units,item.condition,item.forecast,astronomy';
const QUERY_URL = 'http://query.yahooapis.com/v1/public/yql' + QUERY_PARAMS + QUERY_VIEW + ' from ' + QUERY_TABLE;

// Schema keys
const WEATHER_CITY_KEY = 'location-label-override';
const WEATHER_REFRESH_INTERVAL = 'refresh-interval';
const WEATHER_SHOW_COMMENT_IN_PANEL_KEY = 'show-comment-in-panel';
const WEATHER_SHOW_SUNRISE_SUNSET_KEY = 'show-sunrise-sunset';
const WEATHER_SHOW_TEXT_IN_PANEL_KEY = 'show-text-in-panel';
const WEATHER_TRANSLATE_CONDITION_KEY = 'translate-condition';
const WEATHER_TEMPERATURE_UNIT_KEY = 'temperature-unit';
const WEATHER_USE_SYMBOLIC_ICONS_KEY = 'use-symbolic-icons';
const WEATHER_WIND_SPEED_UNIT_KEY = 'wind-speed-unit';
const WEATHER_WOEID_KEY = 'woeid';

// Signals
const SIGNAL_CHANGED = 'changed::';
const SIGNAL_CLICKED = 'clicked';
const SIGNAL_REPAINT = 'repaint';


//----------------------------------------------------------------------
//
//  Enumerations: org.cinnamon.applets.weather@mockturtl.gschema.xml
//
//----------------------------------------------------------------------

const WeatherUnits = {
	CELSIUS: 0,
	FAHRENHEIT: 1
}
const WeatherWindSpeedUnits = {
	KPH: 0,
	MPH: 1,
	MPS: 2,
	KNOTS: 3
}

//----------------------------------------------------------------------
//
//  Soup
//
//----------------------------------------------------------------------

// Soup session (see https://bugzilla.gnome.org/show_bug.cgi?id=661323#c64)
const _httpSession = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

//----------------------------------------------------------------------
//
//  Gschema
//
//----------------------------------------------------------------------

function getSettings(schema) {
	if (Gio.Settings.list_schemas().indexOf(schema) == -1)
		throw _("Schema \"%s\" not found.").format(schema);
	return new Gio.Settings({ schema: schema });
}

//----------------------------------------------------------------------
//
//  l10n
//
//----------------------------------------------------------------------

Gettext.textdomain(UUID);
Gettext.bindtextdomain(UUID, GLib.get_home_dir() +"/.local/share/locale");

//----------------------------------------------------------------------
//
//  Factory: MyMenu
//
//----------------------------------------------------------------------

/**
 * MyMenu constructor.
 */
function MyMenu(launcher, orientation) {
	this._init(launcher, orientation);
}

MyMenu.prototype = {
	__proto__: PopupMenu.PopupMenu.prototype,

	//----------------------------------
	//  Override Methods: PopupMenu
	//----------------------------------

	_init: function(launcher, orientation) {
		this._launcher = launcher;
		PopupMenu.PopupMenu.prototype._init.call(this, launcher.actor, 0.0, orientation, 0);
		Main.uiGroup.add_actor(this.actor);
		this.actor.hide();
	}
}

//----------------------------------------------------------------------
//
//  Factory: MyApplet
//
//----------------------------------------------------------------------


/**
 * MyApplet constructor.
 */
function MyApplet(orientation) {
	this._init(orientation);
}

MyApplet.prototype = {
	__proto__: Applet.TextIconApplet.prototype,

	//----------------------------------
	//  Override Methods: TextIconApplet
	//----------------------------------

	_init: function(orientation) {
		Applet.TextIconApplet.prototype._init.call(this, orientation);

		try {
			//----------------------------------
			//  Interface Methods: TextIconApplet
			//----------------------------------
			this.set_applet_icon_name(APPLET_ICON);
			this.set_applet_label(APPLET_LABEL);
			this.set_applet_tooltip(_(APPLET_TOOLTIP));

			//----------------------------------
			//  PopupMenu
			//----------------------------------
			this.menuManager = new PopupMenu.PopupMenuManager(this);
			this.menu = new MyMenu(this, orientation);
			this.menuManager.addMenu(this.menu);

			//----------------------------------
			//  Event Handlers
			//----------------------------------
			let load_settings_and_refresh_weather = Lang.bind(this, function() {
				//global.log("cinnamon-weather::load_settings_and_refresh_weather");
				this._units = this._settings.get_enum(WEATHER_TEMPERATURE_UNIT_KEY);
				this._wind_speed_units = this._settings.get_enum(WEATHER_WIND_SPEED_UNIT_KEY);
				this._city  = this._settings.get_string(WEATHER_CITY_KEY);
				this._woeid = this._settings.get_string(WEATHER_WOEID_KEY);
				this._translate_condition = this._settings.get_boolean(WEATHER_TRANSLATE_CONDITION_KEY);
				this._show_sunrise = this._settings.get_boolean(WEATHER_SHOW_SUNRISE_SUNSET_KEY);
				this._icon_type = this._settings.get_boolean(WEATHER_USE_SYMBOLIC_ICONS_KEY) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
				this._text_in_panel = this._settings.get_boolean(WEATHER_SHOW_TEXT_IN_PANEL_KEY);
				this._comment_in_panel = this._settings.get_boolean(WEATHER_SHOW_COMMENT_IN_PANEL_KEY);
				this.refreshWeather(false);
			});

			//----------------------------------
			//  initialize settings
			//----------------------------------
			this._settings = getSettings(GSETTINGS_SCHEMA);
			this._units = this._settings.get_enum(WEATHER_TEMPERATURE_UNIT_KEY);
			this._wind_speed_units = this._settings.get_enum(WEATHER_WIND_SPEED_UNIT_KEY);
			this._city  = this._settings.get_string(WEATHER_CITY_KEY);
			this._woeid = this._settings.get_string(WEATHER_WOEID_KEY);
			this._translate_condition = this._settings.get_boolean(WEATHER_TRANSLATE_CONDITION_KEY);
			this._show_sunrise = this._settings.get_boolean(WEATHER_SHOW_SUNRISE_SUNSET_KEY);
			this._icon_type = this._settings.get_boolean(WEATHER_USE_SYMBOLIC_ICONS_KEY) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
			this._text_in_panel = this._settings.get_boolean(WEATHER_SHOW_TEXT_IN_PANEL_KEY);
			this._comment_in_panel = this._settings.get_boolean(WEATHER_SHOW_COMMENT_IN_PANEL_KEY);
			this._refresh_interval = this._settings.get_int(WEATHER_REFRESH_INTERVAL);

			//----------------------------------
			//  bind settings
			//----------------------------------
			let refreshableKeys = [
				WEATHER_TEMPERATURE_UNIT_KEY, 
				WEATHER_WIND_SPEED_UNIT_KEY,
				WEATHER_CITY_KEY,
				WEATHER_WOEID_KEY,
				WEATHER_TRANSLATE_CONDITION_KEY,
				WEATHER_SHOW_TEXT_IN_PANEL_KEY,
				WEATHER_SHOW_COMMENT_IN_PANEL_KEY,
				WEATHER_SHOW_SUNRISE_SUNSET_KEY
			];
			context = this;
			refreshableKeys.forEach(function (key) {
				//global.log("cinnamon-weather::_init: adding CHANGED listener for " + key + "; " + context);
				context._settings.connect(SIGNAL_CHANGED + key, load_settings_and_refresh_weather);
			});
			
			this._settings.connect(SIGNAL_CHANGED + WEATHER_USE_SYMBOLIC_ICONS_KEY, Lang.bind(this, function() {
				this._icon_type = this._settings.get_boolean(WEATHER_USE_SYMBOLIC_ICONS_KEY) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
				this._applet_icon.icon_type = this._icon_type;
				this._currentWeatherIcon.icon_type = this._icon_type;
				this._forecast[0].Icon.icon_type = this._icon_type;
				this._forecast[1].Icon.icon_type = this._icon_type;
				this.refreshWeather(false);
			}));
			
			this._settings.connect(SIGNAL_CHANGED + WEATHER_REFRESH_INTERVAL, Lang.bind(this, function() {
				this._refresh_interval = this._settings.get_int(WEATHER_REFRESH_INTERVAL);
			}));

			//------------------------------
			//  render graphics container
			//------------------------------

			// build menu
			let mainBox = new St.BoxLayout({ vertical: true });
			this.menu.addActor(mainBox);

			//	today's forecast
			this._currentWeather = new St.Bin({ style_class: 'current' });
			mainBox.add_actor(this._currentWeather);

			//	horizontal rule
			this._separatorArea = new St.DrawingArea({ style_class: 'popup-separator-menu-item' });
			this._separatorArea.width = 200;
			this._separatorArea.connect(SIGNAL_REPAINT, Lang.bind(this, this._onSeparatorAreaRepaint));
			mainBox.add_actor(this._separatorArea);

			//	tomorrow's forecast
			this._futureWeather = new St.Bin({ style_class: 'forecast' });
			mainBox.add_actor(this._futureWeather);

			this.showLoadingUi();
			this.rebuildCurrentWeatherUi();
			this.rebuildFutureWeatherUi();

			//------------------------------
			//  run
			//------------------------------
			Mainloop.timeout_add_seconds(3, Lang.bind(this, function() {
				this.refreshWeather(true);
			}));

		} catch (e) {
			global.logError("cinnamon-weather::_init: " + e);
		}
	 },

	//----------------------------------
	//  Event Handlers: MyApplet
	//----------------------------------


	/**
	 * Called when the panel icon is clicked.
	 */
	on_applet_clicked: function(event) {
		//global.log("cinnamon-weather::applet click " + event);
		this.menu.toggle();
	},

	/**
	 * Draw a horizontal rule in the menu.
	 */
	_onSeparatorAreaRepaint: function(area) {
		let cr = area.get_context();
		let themeNode = area.get_theme_node();
		let [width, height] = area.get_surface_size();
		let margin = themeNode.get_length('-margin-horizontal');
		let gradientHeight = themeNode.get_length('-gradient-height');
		let startColor = themeNode.get_color('-gradient-start');
		let endColor = themeNode.get_color('-gradient-end');

		let gradientWidth = (width - margin * 2);
		let gradientOffset = (height - gradientHeight) / 2;
		let pattern = new Cairo.LinearGradient(margin, gradientOffset, width - margin, gradientOffset + gradientHeight);
		pattern.addColorStopRGBA(0, startColor.red / 255, startColor.green / 255, startColor.blue / 255, startColor.alpha / 255);
		pattern.addColorStopRGBA(0.5, endColor.red / 255, endColor.green / 255, endColor.blue / 255, endColor.alpha / 255);
		pattern.addColorStopRGBA(1, startColor.red / 255, startColor.green / 255, startColor.blue / 255, startColor.alpha / 255);
		cr.setSource(pattern);
		cr.rectangle(margin, gradientOffset, gradientWidth, gradientHeight);
		cr.fill();
	},

	//----------------------------------------------------------------------
	//
	//  Methods
	//
	//----------------------------------------------------------------------

	/**
	 *
	 */
	load_json_async: function(url, fun) {
		let here = this;

		let message = Soup.Message.new('GET', url);
		_httpSession.queue_message(message, function(session, message) {
			let jp = new Json.Parser();
			jp.load_from_data(message.response_body.data, -1);
			fun.call(here, jp.get_root().get_object());
		});
	},

	/**
	 *
	 */
	parse_day: function(abr) {
		let yahoo_days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
		for (var i = 0; i < yahoo_days.length; i++) {
			if (yahoo_days[i].substr(0, abr.length) == abr.toLowerCase()) {
				return i;
			}
		}
		return 0;
	},

	/**
	 *
	 */
	refreshWeather: function(recurse) {
		//global.log("cinnamon-weather::refreshWeather: recurse=" + recurse);
		this.load_json_async(this.get_weather_url(), function(json) {
			try {
				let weather = json.get_object_member('query').get_object_member('results').get_object_member('channel');
				let weather_c = weather.get_object_member('item').get_object_member('condition');
				let forecast = weather.get_object_member('item').get_array_member('forecast').get_elements();
				
				let location = weather.get_object_member('location').get_string_member('city');
				if (this._city != null && this._city.length > 0)
					location = this._city;
				
				// Refresh current weather
				let comment = weather_c.get_string_member('text');
				if (this._translate_condition)
					comment = this.get_weather_condition(weather_c.get_string_member('code'));
				
				let humidity = weather.get_object_member('atmosphere').get_string_member('humidity') + ' %';
				
				let pressure = weather.get_object_member('atmosphere').get_string_member('pressure');
				let pressure_unit = weather.get_object_member('units').get_string_member('pressure');
				
				let sunrise = weather.get_object_member('astronomy').get_string_member('sunrise');
				let sunset = weather.get_object_member('astronomy').get_string_member('sunset');
				
				let temperature = weather_c.get_string_member('temp');
				
				let wind = weather.get_object_member('wind').get_string_member('speed');
				let wind_direction = this.get_compass_direction(weather.get_object_member('wind').get_string_member('direction'));
				let wind_unit = weather.get_object_member('units').get_string_member('speed');
				
				let iconname = this.get_weather_icon_safely(weather_c.get_string_member('code'));
				this._currentWeatherIcon.icon_name = iconname;
				this._icon_type == St.IconType.SYMBOLIC ?
					this.set_applet_icon_symbolic_name(iconname) :
					this.set_applet_icon_name(iconname);

				if (this._text_in_panel) {
					if (this._comment_in_panel) {
						this.set_applet_label(comment + ' ' + temperature + ' ' + this.unit_to_unicode());
					} else {
						this.set_applet_label(temperature + ' ' + this.unit_to_unicode()); 
					}
				} else {
					this.set_applet_label('');
				}
				
				this._currentWeatherSummary.text = comment;
				this._currentWeatherTemperature.text = temperature + ' ' + this.unit_to_unicode();
				this._currentWeatherHumidity.text = humidity;
				this._currentWeatherPressure.text = pressure + ' ' + pressure_unit;
				
				// Override wind units with our preference
				// Need to consider what units the Yahoo API has returned it in
				switch (this._wind_speed_units) {
					case WeatherWindSpeedUnits.KPH:
						// Round to whole units
						if (this._units == WeatherUnits.FAHRENHEIT) {
							wind = Math.round (wind / WEATHER_CONV_MPH_IN_MPS * WEATHER_CONV_KPH_IN_MPS);
							wind_unit = 'km/h';
						}
						// Otherwise no conversion needed - already in correct units
						break;
					case WeatherWindSpeedUnits.MPH:
						// Round to whole units
						if (this._units == WeatherUnits.CELSIUS) {
							wind = Math.round (wind / WEATHER_CONV_KPH_IN_MPS * WEATHER_CONV_MPH_IN_MPS);
							wind_unit = 'mph';
						}
						// Otherwise no conversion needed - already in correct units
						break;
					case WeatherWindSpeedUnits.MPS:
						// Precision to one decimal place as 1 m/s is quite a large unit
						if (this._units == WeatherUnits.CELSIUS)
							wind = Math.round ((wind / WEATHER_CONV_KPH_IN_MPS) * 10)/ 10;
						else
							wind = Math.round ((wind / WEATHER_CONV_MPH_IN_MPS) * 10)/ 10;
						wind_unit = 'm/s';
						break;
					case WeatherWindSpeedUnits.KNOTS:
						// Round to whole units
						if (this._units == WeatherUnits.CELSIUS)
							wind = Math.round (wind / WEATHER_CONV_KPH_IN_MPS * WEATHER_CONV_KNOTS_IN_MPS);
						else
							wind = Math.round (wind / WEATHER_CONV_MPH_IN_MPS * WEATHER_CONV_KNOTS_IN_MPS);
						wind_unit = 'knots';
						break;
				}
				this._currentWeatherWind.text = (wind_direction ? wind_direction + ' ' : '') + wind + ' ' + wind_unit;
				
				// location is a button
				this._currentWeatherLocation.style_class = 'weather-current-location-link';
				this._currentWeatherLocation.url = weather.get_string_member('link');
				this._currentWeatherLocation.label = location;
				
				// gettext can't see these inline
				let sunriseText = _('Sunrise');
				let sunsetText = _('Sunset');
				this._currentWeatherSunrise.text = this._show_sunrise ? (sunriseText + ': ' + sunrise) : '';
				this._currentWeatherSunset.text = this._show_sunrise ? (sunsetText + ': ' + sunset) : '';
				
				// Refresh forecast
				let date_string = [_('Today'), _('Tomorrow')];
				for (let i = 0; i <= 1; i++) {
					let forecastUi = this._forecast[i];
					let forecastData = forecast[i].get_object();

					let code = forecastData.get_string_member('code');
					let t_low = forecastData.get_string_member('low');
					let t_high = forecastData.get_string_member('high');

					let comment = forecastData.get_string_member('text');
					if (this._translate_condition)
						comment = this.get_weather_condition(code);

					forecastUi.Day.text = date_string[i] + ' (' + this.get_locale_day(forecastData.get_string_member('day')) + ')';
					forecastUi.Temperature.text = t_low + ' ' + '\u002F' + ' ' + t_high + ' ' + this.unit_to_unicode();
					forecastUi.Summary.text = comment;
					forecastUi.Icon.icon_name = this.get_weather_icon_safely(code);
				}
			} catch(error) {
				global.logError("cinnamon-weather::refreshWeather: " + e);
			}
		});

		if (recurse) {
			Mainloop.timeout_add_seconds(this._refresh_interval, Lang.bind(this, function() {
				this.refreshWeather(true);
			}));
		}
	},

	/**
	 *
	 */
	destroyCurrentWeather: function() {
		//global.log("cinnamon-weather::destroyCurrentWeather");
		if (this._currentWeather.get_child() != null)
			this._currentWeather.get_child().destroy();
	},

	/**
	 *
	 */
	destroyFutureWeather: function() {
		//global.log("cinnamon-weather::destroyFutureWeather");
		if (this._futureWeather.get_child() != null)
			this._futureWeather.get_child().destroy();
	},

	/**
	 *
	 */
	showLoadingUi: function() {
		//global.log("cinnamon-weather::showLoadingUi");
		this.destroyCurrentWeather();
		this.destroyFutureWeather();
		this._currentWeather.set_child(new St.Label({ text: _('Loading current weather ...') }));
		this._futureWeather.set_child(new St.Label({ text: _('Loading future weather ...') }));
	},

	/**
	 * Assemble today's forecast in the menu.
	 */
	rebuildCurrentWeatherUi: function() {
		//global.log("cinnamon-weather::rebuildCurrentWeatherUi");
		this.destroyCurrentWeather();

		// This will hold the icon for the current weather
		this._currentWeatherIcon = new St.Icon({
			icon_type: this._icon_type,
			icon_size: 64,
			icon_name: APPLET_ICON,
			style_class: 'weather-current-icon'
		});

		// The summary of the current weather
		this._currentWeatherSummary = new St.Label({
			text: _('Loading ...'),
			style_class: 'weather-current-summary'
		});
		
		this._currentWeatherLocation = new St.Button({ 
			reactive: true,
			label: _('Please wait') 
		});
		// link to the details page
		this._currentWeatherLocation.connect(SIGNAL_CLICKED, Lang.bind(this, function() {
			if (this._currentWeatherLocation.url == null)
				return;
			Gio.app_info_launch_default_for_uri(
				this._currentWeatherLocation.url,
				global.create_app_launch_context()
			);
		}));
		
		let bb = new St.BoxLayout({
			vertical: true,
			style_class: 'weather-current-summarybox'
		});
		bb.add_actor(this._currentWeatherLocation);
		bb.add_actor(this._currentWeatherSummary);
		
		
		let textOb = { text: ELLIPSIS };
		this._currentWeatherSunrise = new St.Label(textOb);
		this._currentWeatherSunset = new St.Label(textOb);
		
		let ab = new St.BoxLayout({
			style_class: 'weather-current-astronomy'
		});
		
		ab.add_actor(this._currentWeatherSunrise);
		let ab_spacerlabel = new St.Label({ text: '   ' });
		ab.add_actor(ab_spacerlabel);
		ab.add_actor(this._currentWeatherSunset);
		
		let bb_spacerlabel = new St.Label({ text: '   ' });
		bb.add_actor(bb_spacerlabel);
		bb.add_actor(ab);
		
		// Other labels
		this._currentWeatherTemperature = new St.Label(textOb);
		this._currentWeatherHumidity = new St.Label(textOb);
		this._currentWeatherPressure = new St.Label(textOb);
		this._currentWeatherWind = new St.Label(textOb);

		let rb = new St.BoxLayout({
			style_class: 'weather-current-databox'
		});
		let rb_captions = new St.BoxLayout({
			vertical: true,
			style_class: 'weather-current-databox-captions'
		});
		let rb_values = new St.BoxLayout({
			vertical: true,
			style_class: 'weather-current-databox-values'
		});
		rb.add_actor(rb_captions);
		rb.add_actor(rb_values);

		rb_captions.add_actor(new St.Label({text: _('Temperature:')}));
		rb_values.add_actor(this._currentWeatherTemperature);
		rb_captions.add_actor(new St.Label({text: _('Humidity:')}));
		rb_values.add_actor(this._currentWeatherHumidity);
		rb_captions.add_actor(new St.Label({text: _('Pressure:')}));
		rb_values.add_actor(this._currentWeatherPressure);
		rb_captions.add_actor(new St.Label({text: _('Wind:')}));
		rb_values.add_actor(this._currentWeatherWind);

		let xb = new St.BoxLayout();
		xb.add_actor(bb);
		xb.add_actor(rb);
		xb.add_actor(this.getPreferencesIcon());

		let box = new St.BoxLayout({
			style_class: 'weather-current-iconbox'
		});
		box.add_actor(this._currentWeatherIcon);
		box.add_actor(xb);
		this._currentWeather.set_child(box);
	},

	/**
	 * Assemble tomorrow's forecast in the menu.
	 */
	rebuildFutureWeatherUi: function() {
		//global.log("cinnamon-weather::rebuildFutureWeatherUi");
		this.destroyFutureWeather();

		this._forecast = [];
		this._forecastBox = new St.BoxLayout();
		this._futureWeather.set_child(this._forecastBox);

		for (let i = 0; i <= 1; i++) {
			let forecastWeather = {};

			forecastWeather.Icon = new St.Icon({
				icon_type: this._icon_type,
				icon_size: 48,
				icon_name: APPLET_ICON,
				style_class: 'weather-forecast-icon'
			});
			forecastWeather.Day = new St.Label({
				style_class: 'weather-forecast-day'
			});
			forecastWeather.Summary = new St.Label({
				style_class: 'weather-forecast-summary'
			});
			forecastWeather.Temperature = new St.Label({
				style_class: 'weather-forecast-temperature'
			});

			let by = new St.BoxLayout({
				vertical: true,
				style_class: 'weather-forecast-databox'
			});
			by.add_actor(forecastWeather.Day);
			by.add_actor(forecastWeather.Summary);
			by.add_actor(forecastWeather.Temperature);

			let bb = new St.BoxLayout({
				style_class: 'weather-forecast-box'
			});
			bb.add_actor(forecastWeather.Icon);
			bb.add_actor(by);

			this._forecast[i] = forecastWeather;
			this._forecastBox.add_actor(bb);
		}
	},

	//----------------------------------------------------------------------
	//
	//  Properties
	//
	//----------------------------------------------------------------------

	/**
	 * Gear icon to launch the glade/py menu.
	 */
	getPreferencesIcon: function() {
		let prefIcon = new St.Icon ({
			icon_type: this._icon_type,
			icon_size: 16,
			icon_name: ICON_PREFERENCES
		});
		let prefButton = new St.Button({
			style_class: 'panel-button'
		});
		prefButton.connect(SIGNAL_CLICKED, function() {
			Util.spawn([COMMAND_CONFIGURE]);
			//global.log("cinnamon-weather::Click: preferences");
		});
		let prefBox = new St.BoxLayout({
			style_class: 'weather-config',
			vertical: true
		});
		prefButton.add_actor(prefIcon);
		prefBox.add_actor(prefButton);
		return prefBox;
	},

	/**
	 *
	 */
	unit_to_url: function() {
		return this._units == WeatherUnits.FAHRENHEIT ? 'f' : 'c';
	},

	/**
	 *
	 */
	unit_to_unicode: function() {
		return this._units == WeatherUnits.FAHRENHEIT ? '\u2109' : '\u2103';
	},

	/**
	 *
	 */
	get_weather_url: function() {
		return QUERY_URL + ' where location="' + this._woeid + '" and u="' + this.unit_to_url() + '"';
	},

	/**
	 *
	 */
	get_weather_icon: function(code) {
		/* see http://developer.yahoo.com/weather/#codetable */
		/* fallback icons are: weather-clear-night weather-clear weather-few-clouds-night weather-few-clouds weather-fog weather-overcast weather-severe-alert weather-showers weather-showers-scattered weather-snow weather-storm */
		switch (parseInt(code, 10)) {
			case 0:/* tornado */
				return ['weather-severe-alert'];
			case 1:/* tropical storm */
				return ['weather-severe-alert'];
			case 2:/* hurricane */
				return ['weather-severe-alert'];
			case 3:/* severe thunderstorms */
				return ['weather-severe-alert'];
			case 4:/* thunderstorms */
				return ['weather-storm'];
			case 5:/* mixed rain and snow */
				return ['weather-snow-rain', 'weather-snow'];
			case 6:/* mixed rain and sleet */
				return ['weather-snow-rain', 'weather-snow'];
			case 7:/* mixed snow and sleet */
				return ['weather-snow'];
			case 8:/* freezing drizzle */
				return ['weather-freezing-rain', 'weather-showers'];
			case 9:/* drizzle */
				return ['weather-fog'];
			case 10:/* freezing rain */
				return ['weather-freezing-rain', 'weather-showers'];
			case 11:/* showers */
				return ['weather-showers'];
			case 12:/* showers */
				return ['weather-showers'];
			case 13:/* snow flurries */
				return ['weather-snow'];
			case 14:/* light snow showers */
				return ['weather-snow'];
			case 15:/* blowing snow */
				return ['weather-snow'];
			case 16:/* snow */
				return ['weather-snow'];
			case 17:/* hail */
				return ['weather-snow'];
			case 18:/* sleet */
				return ['weather-snow'];
			case 19:/* dust */
				return ['weather-fog'];
			case 20:/* foggy */
				return ['weather-fog'];
			case 21:/* haze */
				return ['weather-fog'];
			case 22:/* smoky */
				return ['weather-fog'];
			case 23:/* blustery */
				return ['weather-few-clouds'];
			case 24:/* windy */
				return ['weather-few-clouds'];
			case 25:/* cold */
				return ['weather-few-clouds'];
			case 26:/* cloudy */
				return ['weather-overcast'];
			case 27:/* mostly cloudy (night) */
				return ['weather-clouds-night', 'weather-few-clouds-night'];
			case 28:/* mostly cloudy (day) */
				return ['weather-clouds', 'weather-overcast'];
			case 29:/* partly cloudy (night) */
				return ['weather-few-clouds-night'];
			case 30:/* partly cloudy (day) */
				return ['weather-few-clouds'];
			case 31:/* clear (night) */
				return ['weather-clear-night'];
			case 32:/* sunny */
				return ['weather-clear'];
			case 33:/* fair (night) */
				return ['weather-clear-night'];
			case 34:/* fair (day) */
				return ['weather-clear'];
			case 35:/* mixed rain and hail */
				return ['weather-snow-rain', 'weather-showers'];
			case 36:/* hot */
				return ['weather-clear'];
			case 37:/* isolated thunderstorms */
				return ['weather-storm'];
			case 38:/* scattered thunderstorms */
				return ['weather-storm'];
			case 39:/* http://developer.yahoo.com/forum/YDN-Documentation/Yahoo-Weather-API-Wrong-Condition-Code/1290534174000-1122fc3d-da6d-34a2-9fb9-d0863e6c5bc6 */
			case 40:/* scattered showers */
				return ['weather-showers-scattered', 'weather-showers'];
			case 41:/* heavy snow */
				return ['weather-snow'];
			case 42:/* scattered snow showers */
				return ['weather-snow'];
			case 43:/* heavy snow */
				return ['weather-snow'];
			case 44:/* partly cloudy */
				return ['weather-few-clouds'];
			case 45:/* thundershowers */
				return ['weather-storm'];
			case 46:/* snow showers */
				return ['weather-snow'];
			case 47:/* isolated thundershowers */
				return ['weather-storm'];
			case 3200:/* not available */
			default:
				return ['weather-severe-alert'];
		}
	},

	/**
	 *
	 */
	get_weather_icon_safely: function(code) {
		let iconname = this.get_weather_icon(code);
		for (let i = 0; i < iconname.length; i++) {
			if (this.has_icon(iconname[i]))
				return iconname[i];
		}
		return 'weather-severe-alert';
	 },

	/**
	 *
	 */
	has_icon: function(icon) {
		//TODO correct symbolic name? (cf. symbolic_names_for_icon)
		return Gtk.IconTheme.get_default().has_icon(icon + (this._icon_type == St.IconType.SYMBOLIC ? '-symbolic' : ''));
	},

	/**
	 *
	 */
	get_weather_condition: function(code) {
		switch (parseInt(code, 10)){
			case 0:/* tornado */
				return _('Tornado');
			case 1:/* tropical storm */
				return _('Tropical storm');
			case 2:/* hurricane */
				return _('Hurricane');
			case 3:/* severe thunderstorms */
				return _('Severe thunderstorms');
			case 4:/* thunderstorms */
				return _('Thunderstorms');
			case 5:/* mixed rain and snow */
				return _('Mixed rain and snow');
			case 6:/* mixed rain and sleet */
				return _('Mixed rain and sleet');
			case 7:/* mixed snow and sleet */
				return _('Mixed snow and sleet');
			case 8:/* freezing drizzle */
				return _('Freezing drizzle');
			case 9:/* drizzle */
				return _('Drizzle');
			case 10:/* freezing rain */
				return _('Freezing rain');
			case 11:/* showers */
				return _('Showers');
			case 12:/* showers */
				return _('Showers');
			case 13:/* snow flurries */
				return _('Snow flurries');
			case 14:/* light snow showers */
				return _('Light snow showers');
			case 15:/* blowing snow */
				return _('Blowing snow');
			case 16:/* snow */
				return _('Snow');
			case 17:/* hail */
				return _('Hail');
			case 18:/* sleet */
				return _('Sleet');
			case 19:/* dust */
				return _('Dust');
			case 20:/* foggy */
				return _('Foggy');
			case 21:/* haze */
				return _('Haze');
			case 22:/* smoky */
				return _('Smoky');
			case 23:/* blustery */
				return _('Blustery');
			case 24:/* windy */
				return _('Windy');
			case 25:/* cold */
				return _('Cold');
			case 26:/* cloudy */
				return _('Cloudy');
			case 27:/* mostly cloudy (night) */
			case 28:/* mostly cloudy (day) */
				return _('Mostly cloudy');
			case 29:/* partly cloudy (night) */
			case 30:/* partly cloudy (day) */
				return _('Partly cloudy');
			case 31:/* clear (night) */
				return _('Clear');
			case 32:/* sunny */
				return _('Sunny');
			case 33:/* fair (night) */
			case 34:/* fair (day) */
				return _('Fair');
			case 35:/* mixed rain and hail */
				return _('Mixed rain and hail');
			case 36:/* hot */
				return _('Hot');
			case 37:/* isolated thunderstorms */
				return _('Isolated thunderstorms');
			case 38:/* scattered thunderstorms */
			case 39:/* scattered thunderstorms */
				return _('Scattered thunderstorms');
			case 40:/* scattered showers */
				return _('Scattered showers');
			case 41:/* heavy snow */
				return _('Heavy snow');
			case 42:/* scattered snow showers */
				return _('Scattered snow showers');
			case 43:/* heavy snow */
				return _('Heavy snow');
			case 44:/* partly cloudy */
				return _('Partly cloudy');
			case 45:/* thundershowers */
				return _('Thundershowers');
			case 46:/* snow showers */
				return _('Snow showers');
			case 47:/* isolated thundershowers */
				return _('Isolated thundershowers');
			case 3200:/* not available */
			default:
				return _('Not available');
		}
	},

	/**
	 *
	 */
	get_locale_day: function(abr) {
		let days = [_('Monday'), _('Tuesday'), _('Wednesday'), _('Thursday'), _('Friday'), _('Saturday'), _('Sunday')];
		return days[this.parse_day(abr)];
	},

	/**
	 *
	 */
	get_compass_direction: function(deg) {
		let directions = [_('N'), _('NE'), _('E'), _('SE'), _('S'), _('SW'), _('W'), _('NW')];
		return directions[Math.round(deg / 45) % directions.length];
	}

};

//----------------------------------------------------------------------
//
//  Entry point
//
//----------------------------------------------------------------------

function main(metadata, orientation) {
	let myApplet = new MyApplet(orientation);
	return myApplet;
}
