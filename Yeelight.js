/**
 * Yeelight SignalRGB Plugin
 *
 * Controls Yeelight Wi-Fi devices via UDP.
 * Optimized for performance (bitwise math, string repeating) and
 * high resilience (Watchdog timeout for auto-reconnection).
 */

import udp from "@SignalRGB/udp";

export function Name() { return "Yeelight"; }
export function Version() { return "1.0.2"; }
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
let DeviceMaxLedLimit = 150; 
let defaultCount = 1; 
export function DefaultComponentBrand() { return "Yeelight";} 
let vLedNames = [ "LED 1" ]; 
let vLedPositions = [ [0, 0] ]; 

export function ledNames() { return vLedNames; }
export function ledPositions() { return vLedPositions; }

const ChannelArray = [ ["Channel 1", DeviceMaxLedLimit] ];

let lastSentRGBData = ""; 
let lastData = 0; 

export function Initialize() {
    const model = controller.model.trim();
	Yeelight.fetchUDPToken();
	Yeelight.setSupportsBackgroundRGB(controller.supportsBackgroundRGB);
	Yeelight.setSupportsPerLED(controller.supportsPerLED);
	fetchDeviceConfig(model);
	device.setName(YeelightDeviceLibrary.getDeviceNameFromModel(model));
    lastSentRGBData = "";
    lastData = 0;
    lightOff = false; 
}

export function Render() {
	if(Yeelight.getIsTokenActive()) {
		if(!Yeelight.getIsInitialized()) {
			deviceInitialization(); 
			return; 
		}
		sendColors(); 
		checkTimeSinceLastPacket(); 
	} else {
		Yeelight.fetchUDPToken();
		device.pause(500); 
	}
}

export function Shutdown(SystemSuspending) {
	if(SystemSuspending){
		sendColors("#000000"); 
		Yeelight.setIsInitialized(false);
		Yeelight.setToken("");
		Yeelight.setIsInDirectMode(false);
		if (udpServer) {
			udpServer.stop();
			udpServer = undefined;
		}
	}else{
		sendColors(shutdownColor); 
	}
    lastSentRGBData = "";
    lastData = 0;
}

function deviceInitialization() {
	Yeelight.setDevicePower(true);
	Yeelight.setDeviceBrightness(100); 
	Yeelight.setIsInitialized(true);
    lastSentRGBData = "";
    lastData = 0;
    lightOff = false;
}

let lightOff = false;

function sendColors(overrideColor = null) { 
	if(Yeelight.getSupportsPerLED() && (vLedPositions.length > 1  || device.getLedCount() > 1 || Yeelight.getUsesComponents())) {
		if(!Yeelight.getIsInDirectMode()) {
			udpServer.setIDToCheckFor(Yeelight.getPacketIDX()); 
			udpServer.setCallbackFunction((msg) => Yeelight.checkPacketResponse(msg)); 
			Yeelight.setDirectMode();
			device.pause(1000); 
			device.log("[Yeelight] Entering Direct Mode...");
            lastSentRGBData = "";
			return; 
		}

        let currentRGBData = null; 

        if (LightingMode === "Canvas" && !overrideColor) {
            const canvasSourceData = device.channel(ChannelArray[0][0]).getColors("Inline", "RGB");
            currentRGBData = Yeelight.getUsesComponents() ? grabComponentColors(null, canvasSourceData) : grabIndividualColors(null);
        } else {
             currentRGBData = Yeelight.getUsesComponents() ? grabComponentColors(overrideColor, null) : grabIndividualColors(overrideColor);
        }

        if (currentRGBData !== null && currentRGBData !== lastSentRGBData) {
            Yeelight.setRGBPerLED(currentRGBData); 
            lastSentRGBData = currentRGBData; 
        }

	} else {
		const RGBData = grabColors(overrideColor); 

		if(lastData !== RGBData) {
			if(RGBData === 0) {
                if (!lightOff) { 
                    Yeelight.setDeviceBrightness(1);
				    lightOff = true;
                }
			} else {
                if (lightOff) {
				    Yeelight.setDeviceBrightness(100);
                    lightOff = false;
                }
				Yeelight.getSupportsBackgroundRGB() ? Yeelight.setBGRGB(RGBData) : Yeelight.setRGB(RGBData);
			}
			lastData = RGBData; 
		}
	}
}

function grabColors(overrideColor) {
	let col;
	if(overrideColor) { col = hexToRgb(overrideColor); }
    else if (LightingMode === "Forced") { col = hexToRgb(forcedColor); }
    else { col = device.color(0, 0); }

    let r = col[0]; let g = col[1]; let b = col[2];

    if (r > 100 && g === 0 && b === 0) {
        g = 1;
    }

	return (r << 16) | (g << 8) | b; 
}

function grabIndividualColors(overrideColor) {
	let RGBData = ""; 
	for(let iIdx = 0; iIdx < vLedPositions.length; iIdx++) {
		let col; const iPxX = vLedPositions[iIdx][0]; const iPxY = vLedPositions[iIdx][1];
		if(overrideColor) { col = hexToRgb(overrideColor); }
        else if (LightingMode === "Forced") { col = hexToRgb(forcedColor); }
        else { col = device.color(iPxX, iPxY); } 

        let r = col[0]; let g = col[1]; let b = col[2];

        if (r > 100 && g === 0 && b === 0) {
            g = 1;
        }

		const fixedCol = (r << 16) | (g << 8) | b; 
		RGBData += encodeColorToASCII(fixedCol); 
	}
	return RGBData;
}

function grabComponentColors(overrideColor, preFetchedCanvasData = null) {
    const ledCount = device.channel(ChannelArray[0][0]).LedCount(); 

	// Fast Path for solid colors - Zero array allocations
	if (overrideColor || LightingMode === "Forced") {
		const targetHex = overrideColor ? overrideColor : forcedColor;
		const rgb = hexToRgb(targetHex);
		let r = rgb[0], g = rgb[1], b = rgb[2];
		if (r > 100 && g === 0 && b === 0) g = 1; 
		
		const fixedCol = (r << 16) | (g << 8) | b;
		const singleLedAscii = encodeColorToASCII(fixedCol);
		return singleLedAscii.repeat(ledCount); // O(1) String repetition
	}

	// Canvas Data parsing
	let RGBData = []; 
    let finalRGBData = ""; 

    if(device.getLedCount() === 0) { 
		const pulseColor = device.getChannelPulseColor(ChannelArray[0][0]);
		RGBData = device.createColorArray(pulseColor, defaultCount, "Inline", "RGB");
	} else { 
        RGBData = preFetchedCanvasData;
	}

	for(let bytes = 0; bytes < RGBData.length/3; bytes++) {
        let r = Number(RGBData[bytes * 3]) || 0;
        let g = Number(RGBData[bytes * 3 + 1]) || 0;
        let b = Number(RGBData[bytes * 3 + 2]) || 0;

        if (r > 100 && g === 0 && b === 0) {
            g = 1;
        }

		const fixedCol = (r << 16) | (g << 8) | b;
		finalRGBData += encodeColorToASCII(fixedCol); 
	}
	return finalRGBData;
}

function SetupChannels() {
	device.SetLedLimit(DeviceMaxLedLimit);
	for(let i = 0; i < ChannelArray.length; i++) {
		device.addChannel(ChannelArray[i][0], ChannelArray[i][1], defaultCount);
	}
}

function fetchDeviceConfig(model) {
	const deviceConfig = YeelightDeviceLibrary.getModelLayout(model);
    device.log(`[Yeelight] Fetched config for '${model}'. Supports BG RGB: ${deviceConfig.supportsBackgroundRGB}`);
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
    if(Yeelight.getUsesComponents()) { SetupChannels(); }
}

function checkTimeSinceLastPacket() {
	if(Date.now() - (checkTimeSinceLastPacket.lastPollTime || 0) > 9000) {
		Yeelight.UDPKeepalive();
    	checkTimeSinceLastPacket.lastPollTime = Date.now();
	}
	// Run watchdog check on the active socket
	if (udpServer) {
		udpServer.checkWatchdog();
	}
}
checkTimeSinceLastPacket.lastPollTime = 0; 

function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [0, 0, 0];
	const colors = [];
    colors[0] = parseInt(result[1], 16);
    colors[1] = parseInt(result[2], 16);
    colors[2] = parseInt(result[3], 16);
	return colors;
}

// Optimized bitwise base64 logic 
function encodeColorToASCII(color) {
    let totalBytes = color >> 6;
    let c1 = asciiTable[totalBytes >> 12];
    let c2 = asciiTable[(totalBytes >> 6) & 63];
    let c3 = asciiTable[totalBytes & 63];
    let c4 = asciiTable[color & 63];
    return c1 + c2 + c3 + c4;
}

const asciiTable = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z","0","1","2","3","4","5","6","7","8","9","+","/"];

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
        if(udpServer){ udpServer.setIDToCheckFor(0); }
		this.packetIDX = 1;
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"udp_sess_new","params":[]}\r\n`);
        device.log("[Yeelight] Requesting UDP Token...");
	}

	parseUDPToken(authToken) {
        let rawData = authToken.data;
        if (rawData.includes('"message":invalid params')) {
            rawData = rawData.replace('"message":invalid params', '"message":"invalid params"');
        }
		try {
			const response = JSON.parse(rawData);
			if(response.params && response.params.token) {
                device.log("[Yeelight] Token received successfully.");
				this.setToken(response.params.token);
				device.pause(100); 
				this.UDPKeepalive(); 
                if(udpServer) { udpServer.setIDToCheckFor(-1); } 
			} else if (response.error) {
				device.log(`[Yeelight] Error response from device: ${response.error.message}`);
			} 
		} catch (e) {
			device.log(`[Yeelight] Failed to parse token response: ${e}. Raw data: ${authToken.data}`);
		}
	}

	UDPKeepalive() {
        if (this.getToken().length > 0) {
		    this.sendPacket(`{"id":${this.getPacketIDX()},"method":"udp_sess_keep_alive","params":["keeplive_interval",10],"token":"${this.getToken()}"}\r\n`);
        }
	}

	setDevicePower(on) {
		const method = this.getSupportsBackgroundRGB() ? "bg_set_power" : "set_power";
		const state = on ? "on" : "off";
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"${method}","params":["${state}","sudden"],"token":"${this.getToken()}"}\r\n`);
		device.log(`[Yeelight] Setting power state to: ${state}`);
	}

	setDeviceBrightness(brightness) {
		const method = this.getSupportsBackgroundRGB() ? "bg_set_bright" : "set_bright";
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"${method}","params":[${brightness},"sudden",0],"token":"${this.getToken()}"}\r\n`);
		device.log(`[Yeelight] Setting brightness to: ${brightness}`);
	}

	setBGRGB(colors) { 
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"bg_set_rgb","params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}

	setRGB(colors) { 
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"set_rgb","params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}

	setDirectMode() { 
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"activate_fx_mode","params":[{"mode":"direct"}],"token":"${this.getToken()}"}\r\n`);
	}

	setRGBPerLED(RGBData) { 
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"update_leds","params":["${RGBData}"],"token":"${this.getToken()}"}\r\n`);
	}

	checkPacketResponse(msg) { 
        if (!udpServer) { device.log("[Yeelight] Cannot check packet response, udpServer undefined."); return; }
		if(msg.data.includes(`"id":${udpServer.getIDToCheck()}`) && msg.data.includes(`"result":["ok"]`)) {
			device.log("[Yeelight] Direct Mode entered successfully.");
			this.setIsInDirectMode(true);
            udpServer.setIDToCheckFor(-1); 
		} else {
            device.log("[Yeelight] Direct Mode activation failed or response not recognized.");
            udpServer.setIDToCheckFor(-1); 
        }
	}

	sendPacket(packet) {
        // Automatically recover broken or disconnected sockets
		if(udpServer === undefined || !udpServer.server || udpServer.server.state !== udpServer.server.ConnectedState) {
            if (udpServer && typeof udpServer.stop === 'function') udpServer.stop();
            device.log("[Yeelight] Initializing resilient UDP server...");
			udpServer = new UdpSocketServer(controller.ip, 55444); 
			udpServer.start();
            
            this.setToken(""); 
            this.setIsInitialized(false);
            this.setIsInDirectMode(false);
            
            device.pause(100); 
            if (udpServer === undefined || !udpServer.server) {
                 device.log("[Yeelight] UDP Server initialization failed. Cannot send packet.");
                 return;
            }
		}

        if ((this.getToken().length > 0 || packet.includes("udp_sess_new")) &&
            udpServer && udpServer.server && udpServer.server.state === udpServer.server.ConnectedState)
        {
		    udpServer.sendPacket(packet);
		    this.incrementPacketIDX();
        } 
	}
}
const Yeelight = new YeelightProtocol();

class deviceLibrary {
	constructor() {
		this.modelDict = {
			"lamp15" : "Monitor Lightbar Pro",
			"CubeMatrix" : "Cube Matrix",
			"CubePanel" : "Cube Panel",
			"CubeSpot"  : "Cube Spot",
			"CubeLite"  : "Cube Lite",
			"RaysLight" : "Beam RGBIC Lightbar",
			"Chameleon2" : "Obsid RGBIC Light Strip"
		};
		this.reverseModelDict = {
			"Monitor Lightbar Pro": "lamp15",
			"Cube Matrix" : "CubeMatrix",
			"Cube Panel": "CubePanel",
			"Cube Spot" :  "CubeSpot",
			"Cube Lite" : "CubeLite",
			"Beam RGBIC Lightbar" : "RaysLight",
			"Obsid RGBIC Light Strip" : "Chameleon2"
		};
		this.modelLibrary = {
			"Monitor Lightbar Pro": {
				usesComponents: false, supportsStandardRGB: false, supportsBackgroundRGB: true,
				supportsPerLED: false, supportsSegments: true, vLedPositions: [[0, 0]],
				vLedNames: ["Main Zone"], size: [3, 1], defaultCount: 1, DeviceMaxLedLimit: 1,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/monitor-light-bar-pro.png"
			},
			"Cube Matrix": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, 
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150, 
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png"
			},
			"Cube Panel": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, 
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-panel.png"
			},
			"Cube Spot": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, 
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-spot.png"
			},
			"Cube Lite": { 
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, 
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 100, DeviceMaxLedLimit: 100, 
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png" 
			},
			"Obsid RGBIC Light Strip": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false,
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 60, DeviceMaxLedLimit: 120, 
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/obsid-rgbic-light-strip.png"
			},
			"Beam RGBIC Lightbar": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false,
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 168, DeviceMaxLedLimit: 168, 
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/beam-rgbic-light-bar.png"
			},
			"Yeelight Device": { 
				usesComponents: false, supportsStandardRGB: true, supportsBackgroundRGB: false,
				supportsPerLED: false, supportsSegments: false, vLedPositions: [[0, 0]],
				vLedNames: ["Main Zone"], size: [3, 1], defaultCount: 1, DeviceMaxLedLimit: 1,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/obsid-rgbic-light-strip.png"
			}
		};
	}
	getDeviceNameFromModel(model) {
        const modelKey = model.trim();
		const deviceName = this.modelDict[modelKey];
		if (deviceName) { return deviceName; }
        device.log(`[Yeelight] Warning: Unknown model code '${modelKey}' received.`);
		return model; 
	}
	getModelFromDevicename(name) {
		const deviceMode = this.reverseModelDict[name];
		if (deviceMode) { return deviceMode; }
        service.log(`[Yeelight Discovery] Warning: Could not find model code for device name '${name}'.`);
		return "Yeelight Device"; 
	}
	getModelLayout(model) {
         const modelKey = model.trim();
		 let deviceLayout = this.modelLibrary[this.modelDict[modelKey]]; 
		 if (deviceLayout === undefined) {
            device.log(`[Yeelight] Warning: Unknown layout for model code '${modelKey}'. Falling back to default.`);
			deviceLayout = this.modelLibrary["Yeelight Device"]; 
		 }
		 return deviceLayout;
	}
}
const YeelightDeviceLibrary = new deviceLibrary();

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/yeelight/logo.png";
	this.UdpBroadcastAddress = "255.255.255.255";
	this.UdpBroadcastPort = 1982; 
	this.UdpListenPort = 0; 
	this.lastPollTime = 0;
	this.PollInterval = 60000; 
	this.cache = new IPCache(); 
	this.activeSockets = new Map(); 
	this.activeSocketTimer = Date.now();
    this.discoveryInProgress = false; 

	this.Initialize = function(){
		service.log("Initializing Yeelight Discovery Service...");
		this.LoadCachedDevices(); 
	};

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Yeelight Devices...");
        let foundCached = false;
		for(const [key, value] of this.cache.Entries()){
            if (value && value.ip) {
			    service.log(`Found Cached Device: [${key}]`);
			    this.checkCachedDevice(value.ip); 
                foundCached = true;
            } else {
                service.log(`Invalid cached entry found for key ${key}, removing.`);
                this.cache.Remove(key);
            }
		}
        if (!foundCached) { service.log("No valid cached devices found."); }
	};

	this.checkForcedIP = function(ipAddress, deviceName) {
		service.log(`Checking Forced IP: ${ipAddress} for device: ${deviceName}`);
        if (!ipAddress || !deviceName) { service.log("Forced IP check failed: Invalid IP or device name provided."); return; }
		const deviceModel = YeelightDeviceLibrary.getModelFromDevicename(deviceName);
		const deviceConfig = YeelightDeviceLibrary.getModelLayout(deviceModel);
		deviceConfig.id = Math.round(Math.random() * 1e8); 
		deviceConfig.ip = ipAddress;
		deviceConfig.name = deviceName;
		deviceConfig.model = deviceModel;
		const socketServer = new UdpSocketServer(ipAddress, 55444, true, deviceConfig); 
        service.log(`Adding temporary discovery socket for forced IP ${ipAddress}`);
		this.activeSockets.set(ipAddress, socketServer);
		socketServer.start();
        this.activeSocketTimer = Date.now(); 
	};

	this.checkCachedDevice = function(ip) {
		service.log(`Checking Cached IP: ${ip}`);
        if (!ip) { service.log("checkCachedDevice failed: Invalid IP provided."); return; }
		const socketServer = new UdpSocketServer(ip, 55444, true); 
        service.log(`Adding temporary discovery socket for cached IP ${ip}`);
		this.activeSockets.set(ip, socketServer);
		socketServer.start();
        this.activeSocketTimer = Date.now(); 
	};

	this.clearSockets = function() {
        const timeout = 15000; 
		if(Date.now() - this.activeSocketTimer > timeout && this.activeSockets.size > 0) {
			service.log(`Clearing ${this.activeSockets.size} inactive discovery sockets...`);
			for(const [key, socket] of this.activeSockets.entries()){
				service.log(`Stopping discovery socket for IP: [${key}]`);
                if (socket && typeof socket.stop === 'function') { socket.stop(); }
				this.activeSockets.delete(key);
			}
		}
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval || this.discoveryInProgress){ return; } 
        this.discoveryInProgress = true;
		discovery.lastPollTime = Date.now();
        this.activeSocketTimer = Date.now(); 
		service.log("Broadcasting Yeelight SSDP scan...");
        try {
		    service.broadcast(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n`);
        } catch (e) {
             service.log(`Error broadcasting discovery packet: ${e}`);
        } finally {
             setTimeout(() => { this.discoveryInProgress = false; }, 5000);
        }
	};

	this.ResponseStringToObj = function(sResponse) {
        if (typeof sResponse !== 'string') return {};
		const lines = sResponse.split("\r\n");
		const obj = {};
		lines.forEach(line => {
			const parts = line.split(':');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join(':').trim();
                if (key) { obj[key] = value; }
            }
		});
		return obj;
	};

	this.Update = function(){
		for(const cont of service.controllers){
            if (cont && cont.obj && typeof cont.obj.update === 'function') {
			    cont.obj.update();
            }
		}
		this.clearSockets(); 
		this.CheckForDevices(); 
	};

	this.Discovered = function(value) {
        if (!value || !value.ip || !value.response) { service.log("[Yeelight Discovery] Received invalid discovery value object."); return; }
        try {
		    const response = this.ResponseStringToObj(value.response);

            if (!response.support || !response.Location || !response.model || !response.id) {
                service.log(`[Yeelight Discovery] Incomplete response from ${value.ip}. Skipping.`);
                return;
            }

		    value.supportsBackgroundRGB = response.support.includes(`bg_set_rgb`);
		    value.supportsPerLED = response.support.includes(`update_leds`);
		    value.supportsSegments = response.support.includes(`set_segment_rgb`);

		    if(response.Location.includes(`yeelight`)) {
			    service.log(`Identified Yeelight: ${response.model} (${response.name || 'No Name'}) at ${value.ip}`);
			    value.name = (response.name && response.name.length > 0) ? response.name : response.model; 
			    value.id = response.id; 
			    value.model = response.model.trim(); 

			    this.CreateControllerDevice(value); 
		    } 
        } catch (e) {
            service.log(`[Yeelight Discovery] Error processing discovery response from ${value.ip}: ${e}`);
        }
	};

	this.CreateControllerDevice = function(value){
        if (!value || !value.id) { service.log("[Yeelight Discovery] Attempted to create controller with invalid value object."); return; }
		const controller = service.getController(value.id);

		if (controller === undefined) {
            service.log(`Adding new controller: ${value.name} (${value.model}) at ${value.ip}`);
			service.addController(new YeelightController(value));
		} else if (controller.updateWithValue) { 
			controller.updateWithValue(value); 
		} else {
            service.log(`Error: Existing controller for ID ${value.id} missing updateWithValue method.`);
        }
	};
}

class YeelightController {
	constructor(value){
		this.updateWithValue(value); 
		this.initialized = false; 
		this.cacheControllerInfo(this); 
	}

	updateWithValue(value){
		this.id = value?.id ?? "Unknown ID";
		this.port = value?.port ?? 55444; 
		this.ip = value?.ip ?? "Unknown IP";
		this.name = value?.name ?? "Yeelight Device";
		this.model = value?.model ?? "Unknown Model";
		this.supportsStandardRGB = value?.supportsStandardRGB ?? true;
		this.supportsBackgroundRGB = value?.supportsBackgroundRGB ?? false;
		this.supportsPerLED = value?.supportsPerLED ?? false;
		this.supportsSegments = value?.supportsSegments ?? false;

		service.updateController(this); 
	}

	update(){
		if(!this.initialized){
			this.initialized = true; 
            service.log(`Controller initialized: ${this.name} (Model: ${this.model}, ID: ${this.id})`);
			service.updateController(this); 
			service.announceController(this); 
		}
	}

	cacheControllerInfo(value){
        if (value && value.ip && value.id) {
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
        } else {
            service.log("[Yeelight Controller] Attempted to cache invalid controller info.");
        }
	}
}

class UdpSocketServer {
	constructor (ip, port, isDiscoveryServer = false, forcedDiscoveryValues = null) {
		this.server = null; this.listenPort = 0; this.broadcastPort = port; this.ipToConnectTo = ip;
        this.isDiscoveryServer = isDiscoveryServer; this.forcedDiscoveryValues = forcedDiscoveryValues; this.IDToCheckFor = 0;
        this.lastRxTime = Date.now(); // Watchdog Timer Core
		this.log = (m) => { const x=isDiscoveryServer?"[Disc UDP]":"[Dev UDP]"; const l=isDiscoveryServer?service.log:device.log; if(typeof l!=='function'){console.log(`${x} ${m}`);return;} if(typeof m==='object'){l(`${x} ${JSON.stringify(m)}`);}else{l(`${x} ${m}`);}};
        this.responseCallbackFunction = (m) => { };
	}
	setIDToCheckFor(i) { this.IDToCheckFor = i; }
	getIDToCheck() { return this.IDToCheckFor; }
	setCallbackFunction(f) { if (typeof f === 'function') { this.responseCallbackFunction = f; } else { this.log("Error:Invalid cb func."); } }
	
    // Ensure timeout triggers an interface reset
    checkWatchdog() {
        if (!this.isDiscoveryServer && this.server && this.server.state === this.server.ConnectedState) {
            if (Date.now() - this.lastRxTime > 25000) {
                this.log("Watchdog Timeout: No heartbeat detected in 25s. Forcing UDP reconnect.");
                this.onError("Watchdog", "Timeout");
            }
        }
    }
    
    sendPacket(p) { if (this.server && this.server.state === this.server.ConnectedState) { try { this.server.send(p); } catch (e) { this.log(`Send err:${e}`); } } }
	write(p, a, t) { this.log("Warn: write() called."); if (!this.server) { this.server = udp.createSocket(); } if (this.server && this.server.state !== this.server.ClosedState) { try { this.server.write(p, a, t); } catch (e) { this.log(`Write err:${e}`); } } else { this.log(`No write, bad state:${this.server ? this.server.state : 'null'}`); } }
	start() {
        if (this.server) { return; }
        this.server = udp.createSocket();
        this.lastRxTime = Date.now(); 
        if (this.server) {
            this.server.on('error', this.onError.bind(this)); this.server.on('message', this.onMessage.bind(this));
            this.server.on('listening', this.onListening.bind(this)); this.server.on('connection', this.onConnection.bind(this));
            try { this.server.bind(this.listenPort); this.server.connect(this.ipToConnectTo, this.broadcastPort); }
            catch (e) { this.log(`Bind/connect err:${e}`); this.stop(); }
        } else { this.log("Failed create UDP sock."); }
    }
	stop() {
        if (this.server) {
            const tempServer = this.server; this.server = null;
            try { tempServer.removeAllListeners(); tempServer.disconnect(); tempServer.close(); }
            catch (e) { this.log(`Stop err:${e}`); }
        }
    }
	onConnection() {
        if (this.isDiscoveryServer) {
            this.log("Sending token request (Discovery Check)...");
            this.sendPacket(`{"id":0,"method":"udp_sess_new","params":[]}\r\n`);
        }
    }
	onListening() { }
	onMessage(m) {
        this.lastRxTime = Date.now(); // Feed the watchdog
        if (this.isDiscoveryServer) {
            try {
                const r = JSON.parse(m.data);
                if (r?.params?.token?.length > 30) {
                    this.log(`Valid token during check! Confirming device: ${this.ipToConnectTo}`);
                    if (this.forcedDiscoveryValues) { 
                        discovery.CreateControllerDevice(this.forcedDiscoveryValues);
                    } else { 
                        const c = discovery.cache.Get(this.ipToConnectTo);
                        if (c) { discovery.CreateControllerDevice(c); }
                        else { this.log(`No cache found for ${this.ipToConnectTo}.`); }
                    }
                } else { this.log(`Invalid token during check for ${this.ipToConnectTo}.`); }
            } catch (e) { this.log(`Discovery check parse error: ${e}`); }
            finally { this.stop(); discovery.activeSockets.delete(this.ipToConnectTo); } 
            return;
        }
        if (this.IDToCheckFor === 0) { Yeelight.parseUDPToken(m); return; } 
        if (this.IDToCheckFor > 0) { 
            if (this.responseCallbackFunction) { this.responseCallbackFunction(m); }
            else { this.log("Err: ID>0 no cb!"); this.setIDToCheckFor(-1); }
            return;
        }
        if (this.IDToCheckFor === -1 && m.data.includes('"error"')) { 
            Yeelight.parseUDPToken(m); 
        }
	}
	onError(c, e) {
        this.log(`UDP Socket Error: ${c} - ${e}`); this.stop();
        if (!this.isDiscoveryServer) { 
            Yeelight.setIsInitialized(false); Yeelight.setToken(""); Yeelight.setIsInDirectMode(false);
            lastSentRGBData = ""; lastData = 0; udpServer = undefined; 
            device.log("[Yeelight] Main device socket error, reset state. Will attempt reconnect.");
        } else { 
            discovery.activeSockets.delete(this.ipToConnectTo);
        }
    }
}

class IPCache {
	constructor() {
		this.cacheMap = new Map(); 
		this.persistanceId = "ipCache"; 
		this.persistanceKey = "cache"; 
		this.loadAttempted = false; 
		this.PopulateCacheFromStorage(); 
	}

	Add(key, value) {
		if (!key) {
			service.log("[IPCache] Invalid key add attempt.");
			return;
		}
		service.log(`[IPCache] Adding/Updating ${key} in Cache...`);
		this.cacheMap.set(key, value);
		this.Persist(); 
	}

	Remove(key) {
		if (!key) {
			service.log("[IPCache] Invalid key remove attempt.");
			return;
		}
		service.log(`[IPCache] Removing ${key} from Cache...`);
		if (this.cacheMap.delete(key)) { 
			this.Persist(); 
		}
	}

	Has(key) {
		if (!key) return false;
		return this.cacheMap.has(key);
	}

	Get(key) {
		if (!key) return undefined;
		return this.cacheMap.get(key);
	}

	Entries() {
		return this.cacheMap.entries();
	}

	PurgeCache() {
		service.log("[IPCache] Purging IP Cache...");
		try {
			service.removeSetting(this.persistanceId, this.persistanceKey);
			service.log("[IPCache] Cache removed from storage!");
			this.cacheMap.clear(); 
		} catch (error) {
			service.log(`[IPCache] Error purging cache: ${error}`);
		}
	}

	PopulateCacheFromStorage() {
		if (this.loadAttempted) return; 
		this.loadAttempted = true;
		service.log("[IPCache] Populating IP Cache from storage...");

		let storageString;
		try {
			storageString = service.getSetting(this.persistanceId, this.persistanceKey);
		} catch (error) {
			service.log(`[IPCache] Error getting setting: ${error}`);
			return; 
		}

		if (storageString === undefined) {
			service.log(`[IPCache] Cache is empty (no setting found).`);
			return; 
		}

		let parsedValues;
		try {
			parsedValues = JSON.parse(storageString);
		} catch (error) {
			service.log(`[IPCache] Error parsing cache from storage: ${error}. Purging corrupted cache.`);
			this.PurgeCache(); 
			return;
		}

		if (!Array.isArray(parsedValues)) {
			service.log("[IPCache] Cache data from storage is not an array. Purging.");
			this.PurgeCache();
			return;
		}

		if (parsedValues.length === 0) {
			service.log(`[IPCache] Cache is empty (parsed data was empty array).`);
		}

		try {
			const validatedEntries = parsedValues.filter(entry =>
				Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
			);
			if (validatedEntries.length !== parsedValues.length) {
				service.log("[IPCache] Warning: Some invalid entries found in cached data. Loading valid entries only.");
			}
			this.cacheMap = new Map(validatedEntries); 
			service.log(`[IPCache] Cache populated with ${this.cacheMap.size} entries.`);
		} catch (error) {
			service.log(`[IPCache] Error creating Map from parsed cache data: ${error}. Purging cache.`);
			this.PurgeCache(); 
		}
	}

	Persist() {
		service.log("[IPCache] Saving IP Cache...");
		try {
			const entriesArray = Array.from(this.cacheMap.entries());
			service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(entriesArray));
			service.log(`[IPCache] Cache saved with ${entriesArray.length} entries.`);
		} catch (error) {
			service.log(`[IPCache] Error saving cache: ${error}`);
		}
	}

	DumpCache() {
		service.log("--- IP Cache Dump ---");
		if (this.cacheMap.size === 0) {
            service.log("(Cache is empty)");
        } else {
            for (const [key, value] of this.cacheMap.entries()) {
                service.log(`[${key}]: ${JSON.stringify(value)}`);
            }
        }
		service.log("--- End Cache Dump ---");
	}
}
