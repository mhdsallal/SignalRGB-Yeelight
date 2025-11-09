/**
 * Yeelight SignalRGB Plugin
 *
 * Controls Yeelight Wi-Fi devices via UDP.
 * Includes workarounds for common color accuracy issues (Red appearing Orange)
 * and specific device capabilities (e.g., Cube brightness).
 */

import udp from "@SignalRGB/udp";

// Plugin metadata
export function Name() { return "Yeelight"; }
export function Version() { return "1.0.1"; } // Incremented version for changes
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

// User configurable parameters in SignalRGB UI
export function ControllableParameters() {
	return [
		{"property":"shutdownColor", "group":"lighting", "label":"Shutdown Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
	];
}

// Global UDP socket instance for device control
let udpServer;

// Default values, will be overridden by fetchDeviceConfig
let DeviceMaxLedLimit = 150; // Default max LEDs (e.g., 6 * 25 for Cubes)
let defaultCount = 1; // Default LED count per component/zone
export function DefaultComponentBrand() { return "Yeelight";} // For component devices
let vLedNames = [ "LED 1" ]; // Default LED names
let vLedPositions = [ [0, 0] ]; // Default LED positions

export function ledNames() { return vLedNames; }
export function ledPositions() { return vLedPositions; }

// Channel configuration for component devices
const ChannelArray = [ ["Channel 1", DeviceMaxLedLimit] ];

// State variables to prevent sending duplicate data
let lastSourceColorData = null; // Stores JSON string of last canvas data processed
let lastSentRGBData = ""; // Stores the last ASCII string sent via update_leds
let lastData = 0; // Stores the last decimal color value sent via set_rgb/bg_set_rgb

/**
 * Initializes the plugin for a specific device.
 * Fetches configuration, sets up capabilities, and requests UDP token.
 */
export function Initialize() {
    const model = controller.model.trim();
	Yeelight.fetchUDPToken();
    // Set initial capabilities based on discovery data
	Yeelight.setSupportsBackgroundRGB(controller.supportsBackgroundRGB);
	Yeelight.setSupportsPerLED(controller.supportsPerLED);
    // Fetch detailed model config, potentially overriding initial capabilities
	fetchDeviceConfig(model);
	device.setName(YeelightDeviceLibrary.getDeviceNameFromModel(model));
    // Reset state trackers
    lastSourceColorData = null;
    lastSentRGBData = "";
    lastData = 0;
    lightOff = false; // Assume light is initially on
}

/**
 * Main render loop called by SignalRGB.
 * Handles device initialization, color sending, and keepalive packets.
 */
export function Render() {
	if(Yeelight.getIsTokenActive()) {
		if(!Yeelight.getIsInitialized()) {
			deviceInitialization(); // Send initial power/brightness commands
			return; // Wait for initialization commands to send
		}
		sendColors(); // Send color data if needed
		checkTimeSinceLastPacket(); // Send keepalive if necessary
	} else {
		// If token is lost (e.g., device reboot), try to get a new one
		Yeelight.fetchUDPToken();
		device.pause(500); // Wait briefly before retrying
	}
}

/**
 * Handles device shutdown or system suspend.
 * Turns off light or sets shutdown color.
 */
export function Shutdown(SystemSuspending) {
	if(SystemSuspending){
		sendColors("#000000"); // Turn off light on suspend
        // Reset state
		Yeelight.setIsInitialized(false);
		Yeelight.setToken("");
		Yeelight.setIsInDirectMode(false);
		if (udpServer) {
			udpServer.stop();
			udpServer = undefined;
		}
	}else{
		sendColors(shutdownColor); // Set configured shutdown color
	}
    // Clear last sent data trackers on shutdown
    lastSourceColorData = null;
    lastSentRGBData = "";
    lastData = 0;
}

/**
 * Sends initial commands to the device after acquiring a UDP token.
 */
function deviceInitialization() {
	Yeelight.setDevicePower(true);
	Yeelight.setDeviceBrightness(100); // Set initial brightness to 100%
	Yeelight.setIsInitialized(true);
    // Reset trackers again after init commands sent
    lastSourceColorData = null;
    lastSentRGBData = "";
    lastData = 0;
    lightOff = false;
}

// State variable for single-zone brightness handling
let lightOff = false;

/**
 * Determines the current color mode and sends color data accordingly.
 * Includes logic to prevent sending duplicate data (Spam Fix v3).
 */
function sendColors(overrideColor = null) { // Allow forcing a color (e.g., for shutdown)

    // Check if device supports multi-LED control (PerLED) and is configured for it
	if(Yeelight.getSupportsPerLED() && (vLedPositions.length > 1  || device.getLedCount() > 1 || Yeelight.getUsesComponents())) {
		// --- PER-LED DEVICE LOGIC (using update_leds) ---

        // Ensure device is in Direct Mode for update_leds command
		if(!Yeelight.getIsInDirectMode()) {
			udpServer.setIDToCheckFor(Yeelight.getPacketIDX()); // Set ID to expect 'ok' response for
			udpServer.setCallbackFunction((msg) => Yeelight.checkPacketResponse(msg)); // Set function to handle response
			Yeelight.setDirectMode();
			device.pause(1000); // Wait for mode switch
			device.log("[Yeelight] Entering Direct Mode...");
            lastSourceColorData = null; // Force update after mode change
            lastSentRGBData = "";
			return; // Skip sending colors this frame
		}

        let currentRGBData = null; // Final ASCII string to potentially send
        let sourceDataStringForCanvas = null; // Raw canvas data string (for comparison)

        // Determine color source and calculate final ASCII string
        if (LightingMode === "Canvas" && !overrideColor) {
             // CANVAS MODE: Get colors from SignalRGB canvas
            const canvasSourceData = device.channel(ChannelArray[0][0]).getColors("Inline", "RGB");
            sourceDataStringForCanvas = JSON.stringify(canvasSourceData); // Stringify for comparison

            // Only proceed if canvas data has changed since last time
            if (sourceDataStringForCanvas !== lastSourceColorData) {
                // Calculate the new final ASCII string based on canvas data
                currentRGBData = Yeelight.getUsesComponents() ? grabComponentColors(null, canvasSourceData) : grabIndividualColors(null);
                // Don't send yet, compare final string below
            } else {
                // Source data hasn't changed, no need to send anything
                return;
            }
        } else {
             // FORCED or OVERRIDE MODE: Calculate final string directly
             // grab functions handle forcedColor/overrideColor internally
             currentRGBData = Yeelight.getUsesComponents() ? grabComponentColors(overrideColor, null) : grabIndividualColors(overrideColor);
             // Don't send yet, compare final string below
        }

        // SENDING LOGIC (Common for Override, Forced, and changed Canvas)
        // Only send if the FINAL calculated ASCII string is different from the last SENT one
        if (currentRGBData !== null && currentRGBData !== lastSentRGBData) {
            Yeelight.setRGBPerLED(currentRGBData); // Send the UDP packet
            lastSentRGBData = currentRGBData; // Update tracker for the sent ASCII string

            // If this was Canvas data, also update the source data tracker now
            if (LightingMode === "Canvas" && !overrideColor) {
                 lastSourceColorData = sourceDataStringForCanvas;
            }
            // Minimal log to indicate sending (optional)
            // device.log(`[Yeelight] Sending Per LED Data`);
        }

	} else {
		// --- SINGLE-ZONE DEVICE LOGIC (using set_rgb / bg_set_rgb) ---
		const RGBData = grabColors(overrideColor); // Get corrected decimal color value

        // Only send if the final corrected decimal value has changed
		if(lastData !== RGBData) {
			if(RGBData === 0) {
				// Special handling for black/off: Set brightness to minimum
                if (!lightOff) { // Avoid sending redundant brightness commands
                    Yeelight.setDeviceBrightness(1);
				    lightOff = true;
                }
                // Don't send a color command when turning off
			} else {
                // If light was off, restore brightness (might be unreliable depending on device state)
                if (lightOff) {
				    Yeelight.setDeviceBrightness(100);
                    lightOff = false;
                }
                // Send the color command (use bg_set_rgb if supported, else set_rgb)
				Yeelight.getSupportsBackgroundRGB() ? Yeelight.setBGRGB(RGBData) : Yeelight.setRGB(RGBData);
			}
			lastData = RGBData; // Update tracker for the sent decimal value
		}
	}
}


/**
 * Grabs color for single-zone devices, applies simplified red fix, returns decimal value.
 */
function grabColors(overrideColor) {
	let col;
	if(overrideColor) { col = hexToRgb(overrideColor); }
    else if (LightingMode === "Forced") { col = hexToRgb(forcedColor); }
    else { col = device.color(0, 0); } // Get color from top-left pixel

    let r = col[0]; let g = col[1]; let b = col[2];

    // ### Simplified Red Fix (V3 - Conditional G=1) ###
    // If R is brightish, B is zero, AND Green was originally zero, add G=1.
    if (r > 100 && g === 0 && b === 0) {
        g = 1;
    }

	const fixedCol = (r * 65536) + (g * 256) + b; // Convert RGB to decimal
	return fixedCol;
}

/**
 * Grabs colors for non-component multi-LED devices, applies simplified red fix, returns ASCII string.
 */
function grabIndividualColors(overrideColor) {
	let RGBData = ""; // Final ASCII string
	for(let iIdx = 0; iIdx < vLedPositions.length; iIdx++) {
		let col; const iPxX = vLedPositions[iIdx][0]; const iPxY = vLedPositions[iIdx][1];
		if(overrideColor) { col = hexToRgb(overrideColor); }
        else if (LightingMode === "Forced") { col = hexToRgb(forcedColor); }
        else { col = device.color(iPxX, iPxY); } // Get color for specific LED position

        let r = col[0]; let g = col[1]; let b = col[2];

        // ### Simplified Red Fix (V3 - Conditional G=1) ###
        if (r > 100 && g === 0 && b === 0) {
            g = 1;
        }

		const fixedCol = (r * 65536) + (g * 256) + b; // Convert RGB to decimal
		const asciiColor = encodeColorToASCII(fixedCol); // Convert decimal to 4-char ASCII
		RGBData += asciiColor;
	}
	return RGBData;
}

/**
 * Grabs colors for component-based devices, applies simplified red fix, returns ASCII string.
 */
function grabComponentColors(overrideColor, preFetchedCanvasData = null) {
	let RGBData = []; // Array of R, G, B values
    let finalRGBData = ""; // Final ASCII string
    const ledCount = device.channel(ChannelArray[0][0]).LedCount(); // Total LEDs in the channel

	// Get the raw color data based on mode
    if(device.getLedCount() === 0) { // Should not happen for components but handle anyway
		const pulseColor = device.getChannelPulseColor(ChannelArray[0][0]);
		RGBData = device.createColorArray(pulseColor, defaultCount, "Inline", "RGB");
	} else if (overrideColor) { // Use override color if provided
        const rgb = hexToRgb(overrideColor);
        RGBData = Array(ledCount * 3).fill(0).map((_, i) => rgb[i % 3]); // Fill array with override color
	} else if (LightingMode === "Forced") { // Use forced color
        const rgb = hexToRgb(forcedColor);
        RGBData = Array(ledCount * 3).fill(0).map((_, i) => rgb[i % 3]); // Fill array with forced color
	} else { // Use Canvas data (either pre-fetched or grab now)
        RGBData = preFetchedCanvasData || device.channel(ChannelArray[0][0]).getColors("Inline", "RGB");
	}

    // Process each LED color
	for(let bytes = 0; bytes < RGBData.length/3; bytes++) {
        let r = Number(RGBData[bytes * 3]) || 0;
        let g = Number(RGBData[bytes * 3 + 1]) || 0;
        let b = Number(RGBData[bytes * 3 + 2]) || 0;

        // ### Simplified Red Fix (V3 - Conditional G=1) ###
        if (r > 100 && g === 0 && b === 0) {
            g = 1;
        }

		const fixedCol = (r * 65536) + (g * 256) + b; // Convert RGB to decimal
		const asciiColor = encodeColorToASCII(fixedCol); // Convert decimal to 4-char ASCII
		finalRGBData += asciiColor;
	}
	return finalRGBData;
}


// --- Helper Functions and Protocol Implementation ---

/**
 * Sets up SignalRGB channels for component-based devices.
 */
function SetupChannels() {
	device.SetLedLimit(DeviceMaxLedLimit);
	for(let i = 0; i < ChannelArray.length; i++) {
		device.addChannel(ChannelArray[i][0], ChannelArray[i][1], defaultCount);
	}
}

/**
 * Fetches the specific configuration for the detected device model
 * from the deviceLibrary and applies it.
 */
function fetchDeviceConfig(model) {
	const deviceConfig = YeelightDeviceLibrary.getModelLayout(model);
    device.log(`[Yeelight] Fetched config for '${model}'. Supports BG RGB: ${deviceConfig.supportsBackgroundRGB}`);
    // Apply fetched configuration
	vLedNames = deviceConfig.vLedNames;
    vLedPositions = deviceConfig.vLedPositions;
    defaultCount = deviceConfig.defaultCount;
    DeviceMaxLedLimit = deviceConfig.DeviceMaxLedLimit;
	Yeelight.setUsesComponents(deviceConfig.usesComponents);
    Yeelight.setSupportsStandardRGB(deviceConfig.supportsStandardRGB);
	Yeelight.setSupportsBackgroundRGB(deviceConfig.supportsBackgroundRGB); // **Crucial**: Overwrites initial value
	Yeelight.setSupportsPerLED(deviceConfig.supportsPerLED);
    Yeelight.setSupportsSegments(deviceConfig.supportsSegments);
	device.SetIsSubdeviceController(deviceConfig.usesComponents);
    device.setControllableLeds(deviceConfig.vLedNames, deviceConfig.vLedPositions);
	device.setSize(deviceConfig.size);
    device.setImageFromUrl(deviceConfig.imageURL);
	// Setup channels if this device uses components
    if(Yeelight.getUsesComponents()) { SetupChannels(); }
}

/**
 * Sends a keepalive packet if ~9 seconds have passed since the last packet.
 */
function checkTimeSinceLastPacket() {
	if(Date.now() - (checkTimeSinceLastPacket.lastPollTime || 0) < 9000) { return; }
	Yeelight.UDPKeepalive();
    checkTimeSinceLastPacket.lastPollTime = Date.now();
}
checkTimeSinceLastPacket.lastPollTime = 0; // Initialize timestamp

/**
 * Converts a hex color string (#RRGGBB) to an RGB array [R, G, B].
 */
function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [0, 0, 0];
	const colors = [];
    colors[0] = parseInt(result[1], 16);
    colors[1] = parseInt(result[2], 16);
    colors[2] = parseInt(result[3], 16);
	return colors;
}

/**
 * Encodes a decimal color value into the 4-character ASCII format required by Yeelight update_leds.
 */
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

// Base64-like lookup table for encoding
const asciiTable = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z","0","1","2","3","4","5","6","7","8","9","+","/"];

// -------------------------------------------<( Yeelight Protocol Class )>--------------------------------------------------
/**
 * Handles Yeelight UDP protocol commands and state management.
 */
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
            // Fix potential malformed JSON error from some devices
            rawData = rawData.replace('"message":invalid params', '"message":"invalid params"');
        }
		try {
			const response = JSON.parse(rawData);
			if(response.params && response.params.token) {
                device.log("[Yeelight] Token received successfully.");
				this.setToken(response.params.token);
				device.pause(100); // Small pause after getting token
				this.UDPKeepalive(); // Send initial keepalive
                if(udpServer) { udpServer.setIDToCheckFor(-1); } // Mark token as received
			} else if (response.error) {
				device.log(`[Yeelight] Error response from device: ${response.error.message}`);
			} // Ignore 'ok' responses
		} catch (e) {
			device.log(`[Yeelight] Failed to parse token response: ${e}. Raw data: ${authToken.data}`);
		}
	}

	UDPKeepalive() {
        if (this.getToken().length > 0) {
		    this.sendPacket(`{"id":${this.getPacketIDX()},"method":"udp_sess_keep_alive","params":["keeplive_interval",10],"token":"${this.getToken()}"}\r\n`);
            // Minimal logging for keepalive
            // device.log("[Yeelight] Sending Keepalive");
        }
	}

	setDevicePower(on) {
        // Use bg_set_power if device supports it (like Monitor Light Bar Pro back light)
		const method = this.getSupportsBackgroundRGB() ? "bg_set_power" : "set_power";
		const state = on ? "on" : "off";
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"${method}","params":["${state}","sudden"],"token":"${this.getToken()}"}\r\n`);
		device.log(`[Yeelight] Setting power state to: ${state}`);
	}

	setDeviceBrightness(brightness) {
        // Use bg_set_bright if device supports it
		const method = this.getSupportsBackgroundRGB() ? "bg_set_bright" : "set_bright";
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"${method}","params":[${brightness},"sudden",0],"token":"${this.getToken()}"}\r\n`);
		device.log(`[Yeelight] Setting brightness to: ${brightness}`);
	}

	setBGRGB(colors) { // For devices with separate background RGB (decimal color)
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"bg_set_rgb","params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}

	setRGB(colors) { // For devices with primary RGB (decimal color)
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"set_rgb","params":[${colors},"sudden",0],"token":"${this.getToken()}"}\r\n`);
	}

	setDirectMode() { // Enter mode required for update_leds
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"activate_fx_mode","params":[{"mode":"direct"}],"token":"${this.getToken()}"}\r\n`);
	}

	setRGBPerLED(RGBData) { // Send multi-LED data (ASCII encoded string)
		this.sendPacket(`{"id":${this.getPacketIDX()},"method":"update_leds","params":["${RGBData}"],"token":"${this.getToken()}"}\r\n`);
	}

	checkPacketResponse(msg) { // Check response specifically for setDirectMode
        if (!udpServer) { device.log("[Yeelight] Cannot check packet response, udpServer undefined."); return; }
		if(msg.data.includes(`"id":${udpServer.getIDToCheck()}`) && msg.data.includes(`"result":["ok"]`)) {
			device.log("[Yeelight] Direct Mode entered successfully.");
			this.setIsInDirectMode(true);
            udpServer.setIDToCheckFor(-1); // Stop waiting for this specific ID
		} else {
            device.log("[Yeelight] Direct Mode activation failed or response not recognized.");
            udpServer.setIDToCheckFor(-1); // Stop waiting even on failure
        }
	}

	sendPacket(packet) {
        // Initialize UDP server if it doesn't exist
		if(udpServer === undefined) {
            device.log("[Yeelight] Initializing UDP server...");
			udpServer = new UdpSocketServer(controller.ip, 55444); // Use controller IP from SignalRGB
			udpServer.start();
            device.pause(100); // Allow time for socket to bind/connect
            if (udpServer === undefined || !udpServer.server) {
                 device.log("[Yeelight] UDP Server initialization failed. Cannot send packet.");
                 return;
            }
		}
        // Send only if we have a token (or are requesting one) and the socket is connected
        if ((this.getToken().length > 0 || packet.includes("udp_sess_new")) &&
            udpServer && udpServer.server && udpServer.server.state === udpServer.server.ConnectedState)
        {
		    udpServer.sendPacket(packet);
		    this.incrementPacketIDX();
            checkTimeSinceLastPacket.lastPollTime = Date.now(); // Update last send time on successful send
        } else if (!packet.includes("udp_sess_keep_alive")) { // Avoid logging failures for keepalives before token
            if (this.getToken().length === 0) {
                 // Don't log "no token yet" repeatedly
            } else if (!udpServer || !udpServer.server || udpServer.server.state !== udpServer.server.ConnectedState) {
                 device.log(`[Yeelight] Cannot send packet, socket not connected. State: ${udpServer?.server?.state ?? 'null'}`);
            }
        }
	}
}
const Yeelight = new YeelightProtocol();

// -------------------------------------------<( Discovery Service )>--------------------------------------------------
// Classes for device discovery, management, and UDP communication

/**
 * Stores device model information, capabilities, and layout details.
 */
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
		// Configuration for each known model
		this.modelLibrary = {
			"Monitor Lightbar Pro": {
				usesComponents: false, supportsStandardRGB: false, supportsBackgroundRGB: true,
				supportsPerLED: false, supportsSegments: true, vLedPositions: [[0, 0]],
				vLedNames: ["Main Zone"], size: [3, 1], defaultCount: 1, DeviceMaxLedLimit: 1,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/monitor-light-bar-pro.png"
			},
			"Cube Matrix": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, // Corrected for brightness fix
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150, // 25 LEDs * 6 sides/extensions
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png"
			},
			"Cube Panel": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, // Corrected for brightness fix
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-panel.png"
			},
			"Cube Spot": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, // Corrected for brightness fix
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 1, DeviceMaxLedLimit: 150,
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-spot.png"
			},
			"Cube Lite": { // Assuming similar to other cubes
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false, // Corrected for brightness fix
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 100, DeviceMaxLedLimit: 100, // Check actual LED count
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/cube-matrix.png" // Placeholder image?
			},
			"Obsid RGBIC Light Strip": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false,
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 60, DeviceMaxLedLimit: 120, // Check limits
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/obsid-rgbic-light-strip.png"
			},
			"Beam RGBIC Lightbar": {
				usesComponents: true, supportsStandardRGB: true, supportsBackgroundRGB: false,
				supportsPerLED: true, supportsSegments: false, vLedPositions: [], vLedNames: [],
				size: [1, 1], defaultCount: 168, DeviceMaxLedLimit: 168, // Check limits
				imageURL: "https://assets.signalrgb.com/devices/brands/yeelight/beam-rgbic-light-bar.png"
			},
			"Yeelight Device": { // Fallback for unknown devices
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
		return model; // Return original code if not found
	}
	getModelFromDevicename(name) {
		const deviceMode = this.reverseModelDict[name];
		if (deviceMode) { return deviceMode; }
        service.log(`[Yeelight Discovery] Warning: Could not find model code for device name '${name}'.`);
		return "Yeelight Device"; // Fallback model code
	}
	getModelLayout(model) {
         const modelKey = model.trim();
		 let deviceLayout = this.modelLibrary[this.modelDict[modelKey]]; // Look up using Device Name
		 if (deviceLayout === undefined) {
            device.log(`[Yeelight] Warning: Unknown layout for model code '${modelKey}'. Falling back to default.`);
			deviceLayout = this.modelLibrary["Yeelight Device"]; // Use defined fallback
		 }
		 return deviceLayout;
	}
}
const YeelightDeviceLibrary = new deviceLibrary();


/**
 * Manages the discovery process using SSDP broadcasts and response parsing.
 */
export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/yeelight/logo.png";
	this.UdpBroadcastAddress = "255.255.255.255";
	this.UdpBroadcastPort = 1982; // Standard SSDP port for Yeelight
	this.UdpListenPort = 0; // Let OS assign listening port
	this.lastPollTime = 0;
	this.PollInterval = 60000; // Scan every 60 seconds
	this.cache = new IPCache(); // Use IPCache class for persistence
	this.activeSockets = new Map(); // Sockets used for checking cached/forced IPs
	this.activeSocketTimer = Date.now();
    this.discoveryInProgress = false; // Flag to prevent concurrent scans

	this.Initialize = function(){
		service.log("Initializing Yeelight Discovery Service...");
		this.LoadCachedDevices(); // Check previously found devices first
	};

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Yeelight Devices...");
        let foundCached = false;
		for(const [key, value] of this.cache.Entries()){
            if (value && value.ip) {
			    service.log(`Found Cached Device: [${key}]`);
			    this.checkCachedDevice(value.ip); // Send a quick check packet
                foundCached = true;
            } else {
                service.log(`Invalid cached entry found for key ${key}, removing.`);
                this.cache.Remove(key);
            }
		}
        if (!foundCached) { service.log("No valid cached devices found."); }
	};

    // For manually added devices or re-checking
	this.checkForcedIP = function(ipAddress, deviceName) {
		service.log(`Checking Forced IP: ${ipAddress} for device: ${deviceName}`);
        if (!ipAddress || !deviceName) { service.log("Forced IP check failed: Invalid IP or device name provided."); return; }
		const deviceModel = YeelightDeviceLibrary.getModelFromDevicename(deviceName);
		const deviceConfig = YeelightDeviceLibrary.getModelLayout(deviceModel);
        // Create temporary device info
		deviceConfig.id = Math.round(Math.random() * 1e8); // Generate random-ish ID
		deviceConfig.ip = ipAddress;
		deviceConfig.name = deviceName;
		deviceConfig.model = deviceModel;
        // Create a temporary socket to check this IP
		const socketServer = new UdpSocketServer(ipAddress, 55444, true, deviceConfig); // isDiscoveryServer=true
        service.log(`Adding temporary discovery socket for forced IP ${ipAddress}`);
		this.activeSockets.set(ipAddress, socketServer);
		socketServer.start();
        this.activeSocketTimer = Date.now(); // Reset clear timer
	};

    // Check if a cached IP is still responsive
	this.checkCachedDevice = function(ip) {
		service.log(`Checking Cached IP: ${ip}`);
        if (!ip) { service.log("checkCachedDevice failed: Invalid IP provided."); return; }
        // Create a temporary socket to check this IP
		const socketServer = new UdpSocketServer(ip, 55444, true); // isDiscoveryServer=true
        service.log(`Adding temporary discovery socket for cached IP ${ip}`);
		this.activeSockets.set(ip, socketServer);
		socketServer.start();
        this.activeSocketTimer = Date.now(); // Reset clear timer
	};

    // Clean up temporary sockets that didn't respond
	this.clearSockets = function() {
        const timeout = 15000; // 15 seconds
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

    // Send SSDP broadcast
	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval || this.discoveryInProgress){ return; } // Throttle scanning
        this.discoveryInProgress = true;
		discovery.lastPollTime = Date.now();
        this.activeSocketTimer = Date.now(); // Reset clear timer during active scan
		service.log("Broadcasting Yeelight SSDP scan...");
        try {
		    service.broadcast(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n`);
        } catch (e) {
             service.log(`Error broadcasting discovery packet: ${e}`);
        } finally {
             // Allow time for responses before allowing another scan
             setTimeout(() => { this.discoveryInProgress = false; /*service.log("Discovery broadcast finished.");*/ }, 5000);
        }
	};

    // Parse SSDP response headers into an object
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

    // Main update loop for the discovery service
	this.Update = function(){
        // Update existing controllers (if they have update logic)
		for(const cont of service.controllers){
            if (cont && cont.obj && typeof cont.obj.update === 'function') {
			    cont.obj.update();
            }
		}
		this.clearSockets(); // Clean up old check sockets
		this.CheckForDevices(); // Initiate scan if interval passed
	};

    // Process a received SSDP response
	this.Discovered = function(value) {
        if (!value || !value.ip || !value.response) { service.log("[Yeelight Discovery] Received invalid discovery value object."); return; }
        try {
		    const response = this.ResponseStringToObj(value.response);
            // service.log(`Processing discovery response from ${value.ip}`); // Less verbose logging

            // Basic validation of response
            if (!response.support || !response.Location || !response.model || !response.id) {
                service.log(`[Yeelight Discovery] Incomplete response from ${value.ip}. Skipping.`);
                return;
            }

            // Extract capabilities from 'support' string
		    value.supportsBackgroundRGB = response.support.includes(`bg_set_rgb`);
		    value.supportsPerLED = response.support.includes(`update_leds`);
		    value.supportsSegments = response.support.includes(`set_segment_rgb`);

            // Verify it's a Yeelight device via Location header
		    if(response.Location.includes(`yeelight`)) {
			    service.log(`Identified Yeelight: ${response.model} (${response.name || 'No Name'}) at ${value.ip}`);
			    value.name = (response.name && response.name.length > 0) ? response.name : response.model; // Use model if name is empty
			    value.id = response.id; // Use device ID as unique identifier
			    value.model = response.model.trim(); // Trim whitespace from model name

			    this.CreateControllerDevice(value); // Add or update the controller in SignalRGB
		    } else {
                 // service.log(`Device at ${value.ip} does not appear to be a Yeelight device (Location mismatch).`);
            }
        } catch (e) {
            service.log(`[Yeelight Discovery] Error processing discovery response from ${value.ip}: ${e}`);
        }
	};

    // Creates or updates a device controller in SignalRGB
	this.CreateControllerDevice = function(value){
        if (!value || !value.id) { service.log("[Yeelight Discovery] Attempted to create controller with invalid value object."); return; }
        // service.log(`Attempting create/update controller ID: ${value.id}`);
		const controller = service.getController(value.id);

		if (controller === undefined) {
            service.log(`Adding new controller: ${value.name} (${value.model}) at ${value.ip}`);
			service.addController(new YeelightController(value));
		} else if (controller.updateWithValue) { // Check if update method exists
            // service.log(`Updating existing controller: ${value.name}`);
			controller.updateWithValue(value); // Update existing controller with potentially new info (e.g., IP)
		} else {
            service.log(`Error: Existing controller for ID ${value.id} missing updateWithValue method.`);
        }
	};
}


/**
 * Represents a discovered Yeelight device controller within SignalRGB.
 */
class YeelightController {
	constructor(value){
        // service.log(`YeelightController Constructor called for ${value?.name || 'Unknown'}`);
		this.updateWithValue(value); // Initialize properties
		this.initialized = false; // Flag to track if initial announcement sent
		this.cacheControllerInfo(this); // Save info to persistent cache
	}

    // Updates controller properties from discovery data
	updateWithValue(value){
        // service.log(`Updating controller ${this.id} with new data from ${value?.ip}`);
		this.id = value?.id ?? "Unknown ID";
		this.port = value?.port ?? 55444; // Default Yeelight port
		this.ip = value?.ip ?? "Unknown IP";
		this.name = value?.name ?? "Yeelight Device";
		this.model = value?.model ?? "Unknown Model";
        // Store capabilities found during discovery
		this.supportsStandardRGB = value?.supportsStandardRGB ?? true;
		this.supportsBackgroundRGB = value?.supportsBackgroundRGB ?? false;
		this.supportsPerLED = value?.supportsPerLED ?? false;
		this.supportsSegments = value?.supportsSegments ?? false;

		service.updateController(this); // Notify SignalRGB of potential changes
	}

    // Called periodically by the discovery service update loop
	update(){
		if(!this.initialized){
			this.initialized = true; // Mark as initialized
            service.log(`Controller initialized: ${this.name} (Model: ${this.model}, ID: ${this.id})`);
			service.updateController(this); // Ensure SignalRGB has latest info
			service.announceController(this); // Make device available in SignalRGB UI
		}
        // Can add logic here later if needed (e.g., periodic status checks)
	}

    // Saves device info to persistent storage
	cacheControllerInfo(value){
        if (value && value.ip && value.id) {
            // service.log(`Caching controller info for ${value.name} (IP: ${value.ip})`);
		    discovery.cache.Add(value.ip, { // Use IP as the key
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


/**
 * Manages a UDP socket connection for discovery checks or device control.
 * Condensed logging for cleaner output.
 */
class UdpSocketServer {
	constructor (ip, port, isDiscoveryServer = false, forcedDiscoveryValues = null) {
		this.server = null; this.listenPort = 0; this.broadcastPort = port; this.ipToConnectTo = ip;
        this.isDiscoveryServer = isDiscoveryServer; this.forcedDiscoveryValues = forcedDiscoveryValues; this.IDToCheckFor = 0;
		this.log = (m) => { const x=isDiscoveryServer?"[Disc UDP]":"[Dev UDP]"; const l=isDiscoveryServer?service.log:device.log; if(typeof l!=='function'){console.log(`${x} ${m}`);return;} if(typeof m==='object'){l(`${x} ${JSON.stringify(m)}`);}else{l(`${x} ${m}`);}};
        this.responseCallbackFunction = (m) => { /*this.log(`Warn: Default CB`);*/ };
	}
	setIDToCheckFor(i) { /*this.log(`Set IDToCheck:${i}`);*/ this.IDToCheckFor = i; }
	getIDToCheck() { return this.IDToCheckFor; }
	setCallbackFunction(f) { if (typeof f === 'function') { this.responseCallbackFunction = f; } else { this.log("Error:Invalid cb func."); } }
	sendPacket(p) { if (this.server && this.server.state === this.server.ConnectedState) { try { this.server.send(p); } catch (e) { this.log(`Send err:${e}`); } } else { /* Ignore if not connected */ } }
    // write() function is likely unused in this plugin's logic
	write(p, a, t) { this.log("Warn: write() called."); if (!this.server) { this.server = udp.createSocket(); } if (this.server && this.server.state !== this.server.ClosedState) { try { this.server.write(p, a, t); } catch (e) { this.log(`Write err:${e}`); } } else { this.log(`No write, bad state:${this.server ? this.server.state : 'null'}`); } }
	start() {
        if (this.server) { return; }
        // this.log(`Starting UDP for ${this.ipToConnectTo}:${this.broadcastPort}...`);
        this.server = udp.createSocket();
        if (this.server) {
            this.server.on('error', this.onError.bind(this)); this.server.on('message', this.onMessage.bind(this));
            this.server.on('listening', this.onListening.bind(this)); this.server.on('connection', this.onConnection.bind(this));
            try { this.server.bind(this.listenPort); this.server.connect(this.ipToConnectTo, this.broadcastPort); }
            catch (e) { this.log(`Bind/connect err:${e}`); this.stop(); }
        } else { this.log("Failed create UDP sock."); }
    }
	stop() {
        // this.log(`Stopping UDP for ${this.ipToConnectTo}...`);
        if (this.server) {
            const tempServer = this.server; this.server = null;
            try { tempServer.removeAllListeners(); tempServer.disconnect(); tempServer.close(); /*this.log("UDP Socket stopped.");*/ }
            catch (e) { this.log(`Stop err:${e}`); }
        }
    }
	onConnection() {
        // this.log('UDP Connected!');
        if (this.isDiscoveryServer) {
            this.log("Sending token request (Discovery Check)...");
            this.sendPacket(`{"id":0,"method":"udp_sess_new","params":[]}\r\n`);
        }
    }
	onListening() { /* Optional: Log listening state */ }
	onMessage(m) {
        // this.log('UDP Data received');
        if (this.isDiscoveryServer) {
            // Logic for handling responses during discovery checks
            try {
                const r = JSON.parse(m.data);
                if (r?.params?.token?.length > 30) {
                    this.log(`Valid token during check! Confirming device: ${this.ipToConnectTo}`);
                    if (this.forcedDiscoveryValues) { // If checking a forced IP
                        discovery.CreateControllerDevice(this.forcedDiscoveryValues);
                    } else { // If checking a cached IP
                        const c = discovery.cache.Get(this.ipToConnectTo);
                        if (c) { discovery.CreateControllerDevice(c); }
                        else { this.log(`No cache found for ${this.ipToConnectTo}.`); }
                    }
                } else { this.log(`Invalid token during check for ${this.ipToConnectTo}.`); }
            } catch (e) { this.log(`Discovery check parse error: ${e}`); }
            finally { this.stop(); discovery.activeSockets.delete(this.ipToConnectTo); } // Stop and remove this temp socket
            return;
        }
        // Device Control Logic (main connection)
        if (this.IDToCheckFor === 0) { Yeelight.parseUDPToken(m); return; } // Waiting for initial token
        if (this.IDToCheckFor > 0) { // Waiting for specific command response (e.g., direct mode)
            if (this.responseCallbackFunction) { this.responseCallbackFunction(m); }
            else { this.log("Err: ID>0 no cb!"); this.setIDToCheckFor(-1); }
            return;
        }
        if (this.IDToCheckFor === -1 && m.data.includes('"error"')) { // Idle, but received an error packet
            Yeelight.parseUDPToken(m); // Log the error
        }
        // Ignore non-error packets received while idle (IDToCheckFor === -1)
	}
	onError(c, e) {
        this.log(`UDP Socket Error: ${c} - ${e}`); this.stop();
        if (!this.isDiscoveryServer) { // Error on main device connection
            Yeelight.setIsInitialized(false); Yeelight.setToken(""); Yeelight.setIsInDirectMode(false);
            lastSentRGBData = ""; lastData = 0; udpServer = undefined; // Reset state
            device.log("[Yeelight] Main device socket error, reset state. Will attempt reconnect.");
        } else { // Error on a temporary discovery socket
            discovery.activeSockets.delete(this.ipToConnectTo);
        }
    }
}

/**
 * Simple persistent key-value store for caching discovered device IPs.
 * Condensed logging.
 */
/**
 * Simple persistent key-value store for caching discovered device IPs.
 * Uses SignalRGB's settings API for persistence.
 */
class IPCache {
	constructor() {
		this.cacheMap = new Map(); // In-memory cache
		this.persistanceId = "ipCache"; // ID for storing settings
		this.persistanceKey = "cache"; // Key within the settings storage
		this.loadAttempted = false; // Flag to prevent multiple load attempts if storage fails
		this.PopulateCacheFromStorage(); // Load existing cache on startup
	}

	/**
	 * Adds or updates a key-value pair in the cache and persists it.
	 * @param {string} key - The key (usually IP address).
	 * @param {object} value - The value object to store (device info).
	 */
	Add(key, value) {
		if (!key) {
			service.log("[IPCache] Invalid key add attempt.");
			return;
		}
		service.log(`[IPCache] Adding/Updating ${key} in Cache...`);
		this.cacheMap.set(key, value);
		this.Persist(); // Save changes to storage
	}

	/**
	 * Removes an entry from the cache by key and persists the change.
	 * @param {string} key - The key to remove.
	 */
	Remove(key) {
		if (!key) {
			service.log("[IPCache] Invalid key remove attempt.");
			return;
		}
		service.log(`[IPCache] Removing ${key} from Cache...`);
		if (this.cacheMap.delete(key)) { // delete returns true if key existed
			this.Persist(); // Save changes to storage
		}
	}

	/**
	 * Checks if a key exists in the cache.
	 * @param {string} key - The key to check.
	 * @returns {boolean} True if the key exists, false otherwise.
	 */
	Has(key) {
		if (!key) return false;
		return this.cacheMap.has(key);
	}

	/**
	 * Retrieves the value associated with a key from the cache.
	 * @param {string} key - The key to retrieve.
	 * @returns {object | undefined} The value object or undefined if not found.
	 */
	Get(key) {
		if (!key) return undefined;
		return this.cacheMap.get(key);
	}

	/**
	 * Returns an iterator for [key, value] pairs in the cache.
	 * @returns {IterableIterator<[string, object]>}
	 */
	Entries() {
		return this.cacheMap.entries();
	}

	/**
	 * Clears the entire cache from both memory and persistent storage.
	 */
	PurgeCache() {
		service.log("[IPCache] Purging IP Cache...");
		try {
			service.removeSetting(this.persistanceId, this.persistanceKey);
			service.log("[IPCache] Cache removed from storage!");
			this.cacheMap.clear(); // Clear the in-memory map too
		} catch (error) {
			service.log(`[IPCache] Error purging cache: ${error}`);
		}
	}

	/**
	 * Loads the cache data from persistent storage into the in-memory map.
	 * Includes checks for corrupted or invalid data.
	 */
	PopulateCacheFromStorage() {
		if (this.loadAttempted) return; // Prevent retrying if loading failed once
		this.loadAttempted = true;
		service.log("[IPCache] Populating IP Cache from storage...");

		let storageString;
		try {
			storageString = service.getSetting(this.persistanceId, this.persistanceKey);
		} catch (error) {
			service.log(`[IPCache] Error getting setting: ${error}`);
			return; // Stop if storage cannot be read
		}

		if (storageString === undefined) {
			service.log(`[IPCache] Cache is empty (no setting found).`);
			return; // Nothing to load
		}

		let parsedValues;
		try {
			parsedValues = JSON.parse(storageString);
		} catch (error) {
			service.log(`[IPCache] Error parsing cache from storage: ${error}. Purging corrupted cache.`);
			this.PurgeCache(); // Remove corrupted data
			return;
		}

		if (!Array.isArray(parsedValues)) {
			service.log("[IPCache] Cache data from storage is not an array. Purging.");
			this.PurgeCache();
			return;
		}

		if (parsedValues.length === 0) {
			service.log(`[IPCache] Cache is empty (parsed data was empty array).`);
			// No entries to load, but cache is valid
		}

		try {
			// Validate entries before creating the Map to prevent errors
            // Ensure each entry is an array of [string, object]
			const validatedEntries = parsedValues.filter(entry =>
				Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
			);
			if (validatedEntries.length !== parsedValues.length) {
				service.log("[IPCache] Warning: Some invalid entries found in cached data. Loading valid entries only.");
			}
			this.cacheMap = new Map(validatedEntries); // Populate the in-memory map
			service.log(`[IPCache] Cache populated with ${this.cacheMap.size} entries.`);
		} catch (error) {
			service.log(`[IPCache] Error creating Map from parsed cache data: ${error}. Purging cache.`);
			this.PurgeCache(); // Purge if Map creation fails
		}
	}

	/**
	 * Saves the current in-memory cache map to persistent storage.
	 */
	Persist() {
		service.log("[IPCache] Saving IP Cache...");
		try {
            // Convert Map entries to an array for JSON stringification
			const entriesArray = Array.from(this.cacheMap.entries());
			service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(entriesArray));
			service.log(`[IPCache] Cache saved with ${entriesArray.length} entries.`);
		} catch (error) {
			service.log(`[IPCache] Error saving cache: ${error}`);
		}
	}

	/**
	 * Logs the current contents of the in-memory cache map for debugging.
	 */
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