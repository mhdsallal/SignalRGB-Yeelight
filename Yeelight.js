import udp from "@SignalRGB/udp";

export function Name() { return "Yeelight"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX"; }
export function Size() { return [48, 48]; }
export function DefaultPosition() {return [75, 70]; }
export function DefaultScale(){return 1.0;}
/* global
discovery:readonly
controller:readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"shutdownColor", "group":"lighting", "label":"Shutdown Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
	];
}

let udpServer;

let DeviceMaxLedLimit = 25 * 6;
let defaultCount = 0;
export function DefaultComponentBrand() { return "Yeelight";}
let vLedNames = [ "LED 1" ];
let vLedPositions = [ [0, 0] ];

export function ledNames() {
	return vLedNames;
}

export function ledPositions() {
	return vLedPositions;
}

//Channel Name, Led Limit
const ChannelArray = [ ["Channel 1", DeviceMaxLedLimit] ];

export function Initialize() {
	Yeelight.fetchUDPToken();
	fetchDeviceConfig();
	device.setName(YeelightDeviceLibrary.getDeviceNameFromModel(controller.model));
	Yeelight.setSupportsBackgroundRGB(controller.supportsBackgroundRGB);
	Yeelight.setSupportsPerLED(controller.supportsPerLED);
}

export function Render() {
	if(Yeelight.getIsTokenActive()) {
		if(!Yeelight.getIsInitialized()) {
			deviceInitialization();
			udpServer.setIDToCheckFor(1);

			return;
		}

		sendColors();

		checkTimeSinceLastPacket();
	}
}

export function Shutdown(SystemSuspending) {
	if(SystemSuspending){
		sendColors("#000000");
	}else{
		sendColors(shutdownColor);
	}
}

function deviceInitialization() {
	Yeelight.setDevicePower(true);
	Yeelight.setDeviceBrightness(100);
	Yeelight.setIsInitialized(true);
}

let lastData = 0;
let lightOff = false;

function sendColors(overrideColor) {

	if(Yeelight.getSupportsPerLED() && (vLedPositions.length > 1  || device.getLedCount() > 1)) {
		//Fancy little catch to ensure that we control any devices we can.
		//PERLED devices without a dict are forced to single zone control.
		if(!Yeelight.getIsInDirectMode()) {
			udpServer.setIDToCheckFor(Yeelight.getPacketIDX());
			udpServer.setCallbackFunction((msg) => Yeelight.checkPacketResponse(msg));
			Yeelight.setDirectMode();
			device.pause(1000);
			device.log("DIRECT MODE ETA NOW");

			return;
		}

		Yeelight.setRGBPerLED(Yeelight.getUsesComponents() ? grabComponentColors(overrideColor) : grabIndividualColors(overrideColor));
	} else {
		const RGBData = grabColors(overrideColor);
		//Single Zone Devices seem to respond a tad more slowly. This should help compensate.

		if(lastData !== RGBData) {
			if(RGBData === 0) {
				Yeelight.setDeviceBrightness(1);
				lightOff = true;
			} else if (lightOff) {
				Yeelight.setDeviceBrightness(100);
			}

			Yeelight.getSupportsBackgroundRGB() ? Yeelight.setBGRGB(RGBData) : Yeelight.setRGB(RGBData);
			lastData = RGBData;
		}
	}
}


function grabColors(overrideColor) {
	let col;

	if(overrideColor) {
		col = hexToRgb(overrideColor);
	} else if (LightingMode === "Forced") {
		col = hexToRgb(forcedColor);
	} else {
		col = device.color(0, 0);
	}

	const fixedCol = (col[0] * 65536) + (col[1] * 256) + col[2];

	return fixedCol;
}

function grabIndividualColors(overrideColor) {
	let RGBData = "";

	for(let iIdx = 0; iIdx < vLedPositions.length; iIdx++) {
		let col;
		const iPxX = vLedPositions[iIdx][0];
		const iPxY = vLedPositions[iIdx][1];

		if(overrideColor) {
			col = hexToRgb(overrideColor);
		} else if (LightingMode === "Forced") {
			col = hexToRgb(forcedColor);
		} else {
			col = device.color(iPxX, iPxY);
		}
		const fixedCol = (col[0] * 65536) + (col[1] * 256) + col[2];
		const asciiColor = encodeColorToASCII(fixedCol);
		RGBData += asciiColor;
	}

	return RGBData;
}

function grabComponentColors(overrideColor) {
	let RGBData = [];
	let finalRGBData = "";

	if(device.getLedCount() === 0) {
		const pulseColor = device.getChannelPulseColor(ChannelArray[0][0]);
		RGBData = device.createColorArray(pulseColor, defaultCount, "Inline", "RGB");
	} else if (overrideColor) {
		RGBData = device.createColorArray(overrideColor, device.channel(ChannelArray[0][0]).LedCount(), "Inline", "RGB");
	} else {
		RGBData = device.channel(ChannelArray[0][0]).getColors("Inline", "RGB");
	}


	for(let bytes = 0; bytes < RGBData.length/3; bytes++) {
		const fixedCol = (RGBData[bytes * 3] * 65536) + (RGBData[bytes * 3 + 1] * 256) + RGBData[bytes * 3 + 2];
		const asciiColor = encodeColorToASCII(fixedCol);
		finalRGBData += asciiColor;
	}

	return finalRGBData;
}

function SetupChannels() {
	device.SetLedLimit(DeviceMaxLedLimit);

	for(let i = 0; i < ChannelArray.length; i++) {
		device.addChannel(ChannelArray[i][0], ChannelArray[i][1], defaultCount);
	}
}

function fetchDeviceConfig() {
	const deviceConfig = YeelightDeviceLibrary.getModelLayout(controller.model);
	vLedNames = deviceConfig.vLedNames;
	vLedPositions = deviceConfig.vLedPositions;
	defaultCount = deviceConfig.defaultCount;
	DeviceMaxLedLimit = deviceConfig.DeviceMaxLedLimit;

	Yeelight.setUsesComponents(deviceConfig.usesComponents);
	Yeelight.setSupportsStandardRGB(deviceConfig.supportsStandardRGB);
	Yeelight.setSupportsBackgroundRGB(deviceConfig.supportsBackgroundRGB);
	Yeelight.setSupportsPerLED(deviceConfig.supportsPerLED);
	Yeelight.setSupportsSegments(deviceConfig.supportsSegments);
	device.SetIsSubdeviceController(deviceConfig.usesComponents);
	device.setControllableLeds(deviceConfig.vLedNames, deviceConfig.vLedPositions);
	device.setSize(deviceConfig.size);
	device.setImageFromUrl(deviceConfig.imageURL);

	if(Yeelight.getUsesComponents()) {
		SetupChannels();
	}
}

function checkTimeSinceLastPacket() {
	if(Date.now() - checkTimeSinceLastPacket.lastPollTime < 9000) {
		return;
	}

	Yeelight.UDPKeepalive();
	checkTimeSinceLastPacket.lastPollTime = Date.now();
}

function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	const colors = [];
	colors[0] = parseInt(result[1], 16);
	colors[1] = parseInt(result[2], 16);
	colors[2] = parseInt(result[3], 16);

	return colors;
}

function encodeColorToASCII(color) {
	let encodedData = "";

	let totalBytes = Math.floor(color / 64);
	color = color % 64;

	encodedData += asciiTable[Math.floor(totalBytes / 4096)];
	totalBytes = totalBytes%4096;

	encodedData += asciiTable[Math.floor(totalBytes / 64)];

	totalBytes = totalBytes%64;

	encodedData += asciiTable[totalBytes];
	encodedData += asciiTable[color];

	return encodedData;
}

const asciiTable = [
	"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O",
	"P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
	"p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
	"0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
	"+", "/"
];
//Kicking, screaming, crying, encode to ASCII

// -------------------------------------------<( Discovery Service )>--------------------------------------------------

let UDPServer;

class deviceLibrary {
	constructor() {
		this.modelDict = {
			" lamp15" : "Monitor Lightbar Pro",
			" CubeMatrix" : "Cube Matrix",
			" CubePanel" : "Cube Panel",
			" CubeSpot"  : "Cube Spot",
			" CubeLite"  : "Cube Lite",
			" RaysLight" : "Beam RGBIC Lightbar",
			" Chameleon2" : "Obsid RGBIC Light Strip"
		};

		this.reverseModelDict = {
			"Monitor Lightbar Pro": " lamp15",
			"Cube Matrix" : " CubeMatrix",
			"Cube Panel": " CubePanel",
			"Cube Spot" :  " CubeSpot",
			"Cube Lite" : " CubeLite",
			"Beam RGBIC Lightbar" : " RaysLight",
			"Obsid RGBIC Light Strip" : " Chameleon2"
		};

		this.modelLibrary = {
			"Monitor Lightbar Pro" : {
				usesComponents: false,
				supportsStandardRGB : false,
				supportsBackgroundRGB : true,
				supportsPerLED: false,
				supportsSegments: true,
				vLedPositions : [ [0, 0] ],
				vLedNames : [ "Main Zone" ],
				//Note: this device supports setting the two segements separately.
				// I'll get to that at some point.
				//vLedPositions : [ [0, 0], [2, 0] ],
				//vLedNames : [ "Left Side", "Right Side" ],
				size : [ 3, 1 ],
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/monitor-light-bar-pro.png"
			},
			"Cube Matrix" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 1,
				DeviceMaxLedLimit: 25 * 6,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png"
			},
			"Cube Panel" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 1,
				DeviceMaxLedLimit: 25 * 6,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/cube-panel.png"
			},
			"Cube Spot" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 1,
				DeviceMaxLedLimit: 25 * 6,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/cube-spot.png"
			},
			"Cube Lite" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 100,
				DeviceMaxLedLimit: 100,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png"
			},
			"Obsid RGBIC Light Strip" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 60,
				DeviceMaxLedLimit: 120,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/obsid-rgbic-light-strip.png"
			},
			"Beam RGBIC Lightbar" : {
				usesComponents: true,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: true,
				supportsSegments: false,
				vLedPositions : [ ],
				vLedNames : [ ],
				size : [ 1, 1 ],
				defaultCount: 168,
				DeviceMaxLedLimit: 168,
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/beam-rgbic-light-bar.png"
			},
			"Yeelight Device" : {
				usesComponents: false,
				supportsStandardRGB : true,
				supportsBackgroundRGB : false,
				supportsPerLED: false,
				supportsSegments: false,
				vLedPositions : [ [0, 0] ],
				vLedNames : [ "Main Zone" ],
				size : [ 3, 1 ],
				imageURL : "https://assets.signalrgb.com/devices/brands/yeelight/obsid-rgbic-light-strip.png"
			},
		};
	}

	getDeviceNameFromModel(model) {
		const deviceName = this.modelDict[model];

		if(deviceName) {
			return deviceName;
		}

		return model;
	}

	getModelFromDevicename(name) {
		const deviceMode = this.reverseModelDict[name];

		if(deviceMode) {
			return deviceMode;
		}

		return "Yeelight Device";
	}

	getModelLayout(model) {
		 let deviceLayout = this.modelLibrary[this.modelDict[model]];

		 if(deviceLayout === undefined) {
			deviceLayout = {
				vLedNames : [ "Main Zone" ],
				vLedPositions : [ [ 0, 0 ] ],
				size: [ 2, 2 ],
				usesComponents : false
			};
			//Defaults are good.
		 }

		 return deviceLayout;
	}
}

const YeelightDeviceLibrary = new deviceLibrary();

class YeelightProtocol {
	constructor() {
		this.config = {
			supportsStandardRGB : false,
			supportsBackgroundRGB : false,
			supportsPerLED: false,
			supportsSegments: false,
			usesComponents: false
		};

		this.token = "";
		this.packetIDX = 1;
		this.isInDirectMode = false;
		this.isInitialized = false;
	}

	getPacketIDX() { return this.packetIDX; }
	incrementPacketIDX() { this.packetIDX ++; }

	getIsInDirectMode() { return this.isInDirectMode; }
	setIsInDirectMode(isInDirectMode) { this.isInDirectMode = isInDirectMode; }

	getIsTokenActive() { return this.token.length > 0; }
	getToken() { return this.token; }
	setToken(token) { this.token = token; }

	getUsesComponents() { return this.config.usesComponents; }
	setUsesComponents(usesComponents) { this.config.usesComponents = usesComponents; }

	getSupportsStandardRGB() { return this.config.supportsStandardRGB; }
	setSupportsStandardRGB(supportsStandardRGB) { this.config.supportsStandardRGB = supportsStandardRGB; }

	getSupportsBackgroundRGB() { return this.config.supportsBackgroundRGB; }
	setSupportsBackgroundRGB(supportsBackgroundRGB) { this.config.supportsBackgroundRGB = supportsBackgroundRGB; }

	getSupportsSegments() { return this.config.supportsSegments; }
	setSupportsSegments(supportsSegments) { this.config.supportsSegments = supportsSegments; }

	getSupportsPerLED() { return this.config.supportsPerLED; }
	setSupportsPerLED(supportsPerLED) { this.config.supportsPerLED = supportsPerLED; }

	getIsInitialized() { return this.isInitialized; }
	setIsInitialized(isInitialized) { this.isInitialized = isInitialized; }

	fetchUDPToken() {
		this.packetIDX = 1;
		//this is to make sure we start back from ID 1.
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"udp_sess_new","params":[]}\r\n`);
	}

	parseUDPToken(authToken) {
		this.setToken(JSON.parse(authToken.data).params.token);

		device.pause(100);
		this.UDPKeepalive();
	}
	/** This function is used to ensure we keep our connection to the device alive.
	 * If we don't send a packet every 10 seconds, it will revert to hardware mode according to docs.*/
	UDPKeepalive() {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"udp_sess_keep_alive",
		"params":["keeplive_interval",10],"token":"${this.getToken()}"}\r\n`);
	}
	/** Turn the device on or off.*/
	setDevicePower(on) {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"${this.getSupportsBackgroundRGB() ? "bg_set_power" : "set_power"}",
		"params":["${on ? "on" : "off"}","sudden"],"token":"${this.getToken()}"}\r\n`);
		device.log(`Setting device state to ${on}.`);
	}
	/** Set Device Brightness. Accepts 0-100.*/
	setDeviceBrightness(brightness) {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"${this.getSupportsBackgroundRGB() ? "bg_set_bright" : "set_bright"}",
		"params":[${brightness},"sudden",0],"token":"${this.getToken()}"}\r\n`);
		device.log(`Setting device Brightness to ${brightness}.`);
	}
	/** Set device color if the device's RGB LED is a secondary light like on the lighbar pro.*/
	setBGRGB(colors) {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"bg_set_rgb",
		"params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}
	/** Set device color for devices where the RGB LED is the primary led.*/
	setRGB(colors) {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"set_rgb",
		"params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}
	/** Set the device to direct mode where it can accept more than 1 led worth of data.*/
	setDirectMode() {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"activate_fx_mode",
		"params":[{"mode":"direct"}],"token":"${this.getToken()}"}\r\n`);
	}
	/** Set the device colors while in direct mode and individually addressing leds.*/
	setRGBPerLED(RGBData) {
		this.sendPacket(`{"id":${this.getPacketIDX()},
		"method":"update_leds",
		"params":["${RGBData}"],"token":"${this.getToken()}"}\r\n`);
	}
	/** Fancy packet response checker to ensure that we actually do what we expect.
	 *  At current is only used to ensure we properly pop into direct mode for PERLED.
	 */
	checkPacketResponse(msg) {

		if(msg.data.includes(`"\id\":${udpServer.getIDToCheck()}`) && msg.data.includes(`\"result\":[\"ok\"]`)) {
			device.log("GREAT SUCCESS!");
			Yeelight.setIsInDirectMode(true);
		}
	}
	/** Send a packet whilst ensuring we have an open udp Server and we increment packet idx.*/
	sendPacket(packet) {
		if(udpServer === undefined) {
			udpServer = new UdpSocketServer(controller.ip, 55444);
			udpServer.start();
		}

		udpServer.sendPacket(packet);

		this.incrementPacketIDX();
		checkTimeSinceLastPacket.lastPollTime = Date.now();
	}
}

const Yeelight = new YeelightProtocol();

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/yeelight/logo.png";

	this.firstRun = true;
	this.UdpBroadcastAddress = "255.255.255.255";
	this.UdpBroadcastPort = 1982;
	this.UdpListenPort = 0;

	this.lastPollTime = 0;
	this.PollInterval = 60000;

	this.cache = new IPCache();
	this.activeSockets = new Map();
	this.activeSocketTimer = Date.now();

	this.Initialize = function(){
		service.log("Initializing Plugin!");
		service.log("Searching for network devices...");
		this.LoadCachedDevices();
	};

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Devices...");

		for(const [key, value] of this.cache.Entries()){
			service.log(`Found Cached Device: [${key}: ${JSON.stringify(value)}]`);
			this.checkCachedDevice(value.ip);
		}
	};

	this.checkForcedIP = function(ipAddress, deviceName) {
		service.log(`Checking IP: ${ipAddress}`);

		const deviceModel = YeelightDeviceLibrary.getModelFromDevicename(deviceName);
		const deviceConfig = YeelightDeviceLibrary.getModelLayout(deviceModel);

		deviceConfig.id = Math.round(Math.random() * 100000000),
		deviceConfig.ip = ipAddress;
		deviceConfig.name = deviceName;
		deviceConfig.model = deviceModel;
		//this is a bit hacky as the device ID is randomly generated because resolving is a dice roll.
		//Cache will hold whatever magic ID we made so that settings persist.

		if(UDPServer !== undefined) {
			UDPServer.stop();
			UDPServer = undefined;
		}

		const socketServer = new UdpSocketServer(ipAddress, 55444, true, deviceConfig);
		this.activeSockets.set(ipAddress, socketServer);
		socketServer.start();
	};

	this.checkCachedDevice = function(ip) {
		service.log(`Checking IP: ${ip}`);

		if(UDPServer !== undefined) {
			UDPServer.stop();
			UDPServer = undefined;
		}

		const socketServer = new UdpSocketServer(ip, 55444, true);
		this.activeSockets.set(ip, socketServer);
		socketServer.start();
	};

	this.clearSockets = function() {
		if(Date.now() - this.activeSocketTimer > 15000 && this.activeSockets.size > 0) {
			service.log("Nuking Active Cache Sockets.");

			for(const [key, value] of this.activeSockets.entries()){
				service.log(`Nuking Socket for IP: [${key}]`);
				value.stop();
				this.activeSockets.delete(key);
				//Clear would be more efficient here, however it doesn't kill the socket instantly.
				//We instead would be at the mercy of the GC.
			}
		}
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval){
			return;
		}

		discovery.lastPollTime = Date.now();
		service.log("Broadcasting device scan...");
		service.broadcast(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n`);
	};

	this.ResponseStringToObj = function(sResponse) {
		const sResp = sResponse.toString().split("\r\n");
		const obj = {};
		sResp.forEach(function(property) {
			const tup = property.split(':');
			obj[tup[0]] = tup[1];
		});

		return obj;
	};

	this.Update = function(){
		for(const cont of service.controllers){
			cont.obj.update();
		}

		this.clearSockets();
		this.CheckForDevices();
	};

	this.Discovered = function(value) {
		const response = this.ResponseStringToObj(value.response);
		service.log(`Response: ${value.response}`);

		value.supportsBackgroundRGB = response.support.includes(`bg_set_rgb`);
		value.supportsPerLED = response.support.includes(`update_leds`);
		value.supportsSegments = response.support.includes(`set_segment_rgb`);

		if(response.Location.includes(`yeelight`)) {
			service.log(`We found a yeelight device at ${value.ip}!`);
			value.name = response.name.length > 1 ? response.name : response.model;
			//Note: On my Light Bar Pro, it'll miss 2-3 times on the name. I can either retry or use a dict.
			value.model = response.model;

			if(response.model === " CubeLite"
			) {
				service.log("CUBE!");
				value.supportsPerLED = true;
			}
			this.CreateControllerDevice(value);
		}
	};

	this.CreateControllerDevice = function(value){
		const controller = service.getController(value.id);

		if (controller === undefined) {
			service.addController(new YeelightController(value));
		} else {
			controller.updateWithValue(value);
		}
	};


}

class YeelightController{
	constructor(value){
		this.updateWithValue(value);
		this.initialized = false;

		this.cacheControllerInfo(this);
	}

	updateWithValue(value){
		this.id = value?.id ?? "Unknown ID";
		this.port = value?.port ?? 55544;
		this.ip = value?.ip ?? "Unknown IP";
		this.name = value?.name ?? "Yeelight Device";
		this.model = value?.model ?? "Unknown Model";
		this.supportsStandardRGB = value?.supportsStandardRGB ?? true;
		this.supportsBackgroundRGB = value?.supportsBackgroundRGB ?? false;
		this.supportsPerLED = value?.supportsPerLED ?? false;
		this.supportsSegments = value?.supportsSegments ?? false;

		service.updateController(this);
	} //Lightbar pro supports 2 zones with segment_rgb.

	update(){
		if(!this.initialized){
			this.initialized = true;

			service.updateController(this);
			service.announceController(this);
		}
	}

	cacheControllerInfo(value){
		discovery.cache.Add(value.ip, {
			name: value.name,
			port: value.port,
			ip: value.ip,
			id: value.id,
			model: value.model,
			supportsStandardRGB : value.supportsStandardRGB,
			supportsBackgroundRGB : value.supportsBackgroundRGB,
			supportsPerLED : value?.supportsPerLED,
			supportsSegments : value?.supportsSegments
		});
	}

}


class UdpSocketServer{
	constructor (ip, port, isDiscoveryServer = false, forcedDiscoveryValues) {
		this.count = 0;
		/** @type {udpSocket | null} */
		this.server = null;
		this.listenPort = 0;
		this.broadcastPort = port;
		this.ipToConnectTo = ip;
		this.isDiscoveryServer = isDiscoveryServer;
		this.forcedDiscoveryValues = forcedDiscoveryValues;
		this.IDToCheckFor = 0;

		this.responseCallbackFunction = (msg) => { this.log("No Response Callback Set Callback cannot function"); msg; };

		this.log = (msg) => { this.isDiscoveryServer ? service.log(msg) : device.log(msg); };
	}

	setIDToCheckFor(ID) {
		this.IDToCheckFor = ID;
	}

	getIDToCheck() { return this.IDToCheckFor; }

	setCallbackFunction(responseCallbackFunction) {
		this.responseCallbackFunction = responseCallbackFunction;
	}

	sendPacket(packet) {
		this.server.send(packet);
	}

	write(packet, address, port) {
		if(!this.server) {
			this.server = udp.createSocket();
		}

		this.server.write(packet, address, port);
	}

	start(){
		this.server = udp.createSocket();

		if(this.server){

			// Given we're passing class methods to the server, we need to bind the context (this instance) to the function pointer
			this.server.on('error', this.onError.bind(this));
			this.server.on('message', this.onMessage.bind(this));
			this.server.on('listening', this.onListening.bind(this));
			this.server.on('connection', this.onConnection.bind(this));
			this.server.bind(this.listenPort);
			this.server.connect(this.ipToConnectTo, this.broadcastPort);

			this.log(this.listenPort);
			this.log(this.ipToConnectTo);
		}
	};

	stop(){
		if(this.server) {
			this.server.disconnect();
			this.server.close();
		}
	}

	onConnection(){
		this.log('Connected to remote socket!');
		this.log("Remote Address:");
		this.log(this.server.remoteAddress());

		if(this.isDiscoveryServer) {
			this.server.send(`{"id":0,"method":"udp_sess_new","params":[]}\r\n`);
		}
	};

	onListenerResponse(msg) {
		this.log('Data received from client');
		this.log(msg);
	}

	onListening(){
		const address = this.server.address();
		this.log(`Server is listening at port ${address.port}`);

		// Check if the socket is bound (no error means it's bound but we'll check anyway)
		this.log(`Socket Bound: ${this.server.state === this.server.BoundState}`);
	};
	onMessage(msg){
		this.log('Data received from client');
		this.log(msg);

		if(this.isDiscoveryServer) {

			if(JSON.parse(msg.data).params.token.length > 30) {
				this.log("Checking Cached IP!");
				this.log(this.ipToConnectTo);

				if(this.forcedDiscoveryValues) {
					this.log("Building Device Using Library Entry!");
					discovery.CreateControllerDevice(this.forcedDiscoveryValues);

					return;
				}
				discovery.CreateControllerDevice(discovery.cache.Get(this.ipToConnectTo));
			}

			return;
		}

		if(this.IDToCheckFor === 0) {
			Yeelight.parseUDPToken(msg);

			return;
		}

		this.responseCallbackFunction(msg);
	};
	onError(code, message){
		this.log(`Error: ${code} - ${message}`);
		this.server.close(); // We're done here
	};
}

class IPCache{
	constructor(){
		this.cacheMap = new Map();
		this.persistanceId = "ipCache";
		this.persistanceKey = "cache";

		this.PopulateCacheFromStorage();
	}
	Add(key, value){

		service.log(`Adding ${key} to IP Cache...`);

		this.cacheMap.set(key, value);
		this.Persist();
	}

	Remove(key){
		this.cacheMap.delete(key);
		this.Persist();
	}
	Has(key){
		return this.cacheMap.has(key);
	}
	Get(key){
		return this.cacheMap.get(key);
	}
	Entries(){
		return this.cacheMap.entries();
	}

	PurgeCache() {
		service.removeSetting(this.persistanceId, this.persistanceKey);
		service.log("Purging IP Cache from storage!");
	}

	PopulateCacheFromStorage(){
		service.log("Populating IP Cache from storage...");

		const storage = service.getSetting(this.persistanceId, this.persistanceKey);

		if(storage === undefined){
			service.log(`IP Cache is empty...`);

			return;
		}

		let mapValues;

		try{
			mapValues = JSON.parse(storage);
		}catch(e){
			service.log(e);
		}

		if(mapValues === undefined){
			service.log("Failed to load cache from storage! Cache is invalid!");

			return;
		}

		if(mapValues.length === 0){
			service.log(`IP Cache is empty...`);
		}

		this.cacheMap = new Map(mapValues);
	}

	Persist(){
		service.log("Saving IP Cache...");
		service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
	}

	DumpCache(){
		for(const [key, value] of this.cacheMap.entries()){
			service.log([key, value]);
		}
	}
}
