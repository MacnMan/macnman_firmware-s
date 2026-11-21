/**
 * Macnman LoRaWAN payload codec V5.4 - controllers and nodes
 * Macnman Technologies Pvt. Ltd.
 *
 * V5.0  29-Sep-2025  Amol_Sawale
 * V5.1  13-Oct-2026  Controller frames checked against the MacSet
 *                    LPC-ST-X1 firmware. Change list at the end of the file.
 * V5.2  21-Oct-2026  MacSet LX1 additions, everything else unchanged:
 *                    FPort 3 AT command text (both directions) and the
 *                    MacSet FPort 2 downlink commands. See the end of the file.
 * V5.3  03-Nov-2026  MacSet-L LX2 (MS-L3-CT-X2, 8 relays, 4 analog inputs):
 *                    relays 3-8 in the controller frames and downlinks.
 *                    LX1 and the other boards decode exactly as with V5.2.
 *                    See the end of the file.
 * V5.4  20-Nov-2026  MacSet-L LX2 firmware V1.0.1: schedules for any of the
 *                    8 relays (bit mask), Delay cyclic (type 4), analog
 *                    trigger inputs A1-A4, relays 1-8 in the relay event,
 *                    sampling on FPort 3 / 21 (as LX1).
 *                    Everything else decodes as V5.3. See the end of the file.
 *
 * Entry points
 *   decodeUplink(input)    TTN v3 / ChirpStack v4 style network servers
 *   Decode(fPort, bytes)   Milesight gateway
 *   encodeDownlink(input)  TTN v3 / ChirpStack v4 style network servers.
 *                          Put the port in the JSON as "fPort" and use the
 *                          same FPort for the downlink itself.
 *
 * Uplink frame
 *   [0] frame type   0 boot, 1 periodic data, 2 response, 3 alarm, 4 samples
 *   [1] device type  see DEVICE_TYPES; response frames always carry 2
 *   ...              frame specific, see each decoder below
 *   last 4 bytes     time stamp, seconds (big endian)
 * Controllers send these frames on FPort 2. Their boot and periodic frames
 * carry local time (UTC + 5:30), their response frames carry UTC.
 * Controller relay event (firmware from 15 Oct 2026): FPort 4, its own
 * layout, see decodeRelayEvent(); time stamp UTC.
 *
 * The output keys are the same as in V5.0, spelling included
 * (protocall, responce, SUCCSESS), so existing dashboards keep working.
 */

// =====================================================================
// CONSTANTS
// =====================================================================

var DEVICE_TYPES = {
    0: "RS485_Node",
    1: "Analog_Node",
    2: "RS485_Controller",
    3: "Analog_Controller",
    4: "RS485_Analog_Controller",     // V5.3: MacSet-L LX2, analog inputs and RS485 in one frame
    16: "MacSense_V2.0"
};

// MacSense parameter names, indexed by sensor code.
var SENSOR_FIELD_NAMES = ["level", "temperature", "humidity", "pressure",
    "windspeed", "winddirection", "rainfall", "snowfall", "co2", "pm2.5",
    "levelmm", "levelcm", "levelm3"];

// =====================================================================
// ENTRY POINTS
// =====================================================================

function decodeUplink(input) {
    return {
        data: {
            Payload: addOrderedLists(Decoder(input.bytes, input.fPort), 0)
        },
        warnings: [],
        errors: []
    };
}

function Decode(fPort, bytes) {
    return {
        Payload: addOrderedLists(Decoder(bytes, fPort), 0)
    };
}

// V5.4: ChirpStack keeps a decoded object as a map and shows its keys in a
// random order; a list keeps its order. So every object with numbered keys
// also gets a list of them in order, next to the keys (dashboards read the
// keys, they stay):
//   field1 ... field20            -> fieldList   ["field1: 12.5", "field2: Disabled", ...]
//   motor1Status ... motor4Status -> motorList   ["motor1: on", "motor2: off", ...]
//   r1Status ... r8Status         -> relayList   ["relay1: off", "relay2: on", ...]
//   channel_a_... channel_d_...   -> channelList ["channel_a_current: 4.02", ...]
// LISTS_ONLY true: the numbered keys are taken out once their list is made, so each
// value shows once, in order (ChirpStack view). Set it to false when a dashboard or
// integration reads the values by name (devicedata.field1, controller.motor2Status,
// analogData.channel_a_current, ...): then both are sent.
var LISTS_ONLY = true;

function addOrderedLists(obj, depth) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 4) {
        return obj;
    }
    var fields = [], motors = [], relays = [], channels = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        var m = /^field(\d+)$/.exec(key);
        if (m) {
            fields.push([Number(m[1]), key, key]);
            continue;
        }
        m = /^motor(\d+)Status$/.exec(key);
        if (m) {
            motors.push([Number(m[1]), key, "motor" + m[1]]);
            continue;
        }
        m = /^r(\d+)Status$/.exec(key);
        if (m) {
            relays.push([Number(m[1]), key, "relay" + m[1]]);
            continue;
        }
        m = /^channel_([a-d])(_|$)/.exec(key);
        if (m) {
            channels.push([m[1].charCodeAt(0), key, key]);
            continue;
        }
        addOrderedLists(obj[key], depth + 1);
    }
    function list(items) {
        items.sort(function (a, b) { return a[0] - b[0]; });
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var v = obj[items[i][1]];
            out.push(items[i][2] + ": " + (typeof v === "object" ? JSON.stringify(v) : v));
            if (LISTS_ONLY) {
                delete obj[items[i][1]];
            }
        }
        return out;
    }
    if (fields.length) {
        obj.fieldList = list(fields);
    }
    if (motors.length) {
        obj.motorList = list(motors);
        if (LISTS_ONLY) {
            delete obj.status;      // motor 1 again (older dashboards), now motorList[0]
        }
    }
    if (relays.length) {
        obj.relayList = list(relays);
    }
    if (channels.length) {
        obj.channelList = list(channels);
    }
    return obj;
}

// =====================================================================
// BYTE HELPERS (all multi-byte values are big endian)
// =====================================================================

// One byte as two hex digits, for example 0x0A -> "0a".
function str_pad(byte) {
    var hex = byte.toString(16);
    return (hex.length < 2 ? "0" : "") + hex;
}

function readUint16(bytes, i) {
    return ((bytes[i] << 8) | bytes[i + 1]) >>> 0;
}

function readInt16(bytes, i) {
    var value = readUint16(bytes, i);
    return (value & 0x8000) ? value - 0x10000 : value;
}

function readUint32(bytes, i) {
    return ((bytes[i] << 24) | (bytes[i + 1] << 16) |
        (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

// Time stamp in the last 4 bytes of a frame.
function readTimestamp(bytes) {
    return readUint32(bytes, bytes.length - 4);
}

function isController(deviceType) {
    return deviceType === 2 || deviceType === 3 || deviceType === 4;
}

// 32-bit float from 4 bytes. isMsb 1: ABCD order, 0: CDAB (word swapped).
function GetFloat(dataBytes, isMsb) {
    var view = new DataView(new ArrayBuffer(4));
    if (isMsb) {
        view.setUint8(0, dataBytes[0]);
        view.setUint8(1, dataBytes[1]);
        view.setUint8(2, dataBytes[2]);
        view.setUint8(3, dataBytes[3]);
    } else {
        view.setUint8(2, dataBytes[0]);
        view.setUint8(3, dataBytes[1]);
        view.setUint8(0, dataBytes[2]);
        view.setUint8(1, dataBytes[3]);
    }
    return view.getFloat32(0, false);
}

// Signed 32-bit integer from 4 bytes. isMsb 1: ABCD order, 0: CDAB.
function GetLongInt(dataBytes, isMsb) {
    var view = new DataView(new ArrayBuffer(4));
    if (isMsb) {
        view.setUint8(0, dataBytes[0]);
        view.setUint8(1, dataBytes[1]);
        view.setUint8(2, dataBytes[2]);
        view.setUint8(3, dataBytes[3]);
    } else {
        view.setUint8(2, dataBytes[0]);
        view.setUint8(3, dataBytes[1]);
        view.setUint8(0, dataBytes[2]);
        view.setUint8(1, dataBytes[3]);
    }
    return view.getInt32(0, false);
}

// 32-bit float from 4 bytes in plain byte order (MacSense frames).
function GetFloatFromBytes(byteArray, isLittleEndian) {
    if (isLittleEndian === undefined) {
        isLittleEndian = 1;
    }
    return new DataView(Uint8Array.from(byteArray).buffer)
        .getFloat32(0, isLittleEndian === 1);
}

// Local test helper: "0102ff" -> [1, 2, 255].
function hexToBytes(hex) {
    var bytes = [];
    for (var c = 0; c < hex.length; c += 2) {
        bytes.push(parseInt(hex.substr(c, 2), 16));
    }
    return bytes;
}

// =====================================================================
// MAIN DECODER
// =====================================================================

// 3 Nov 2026: an AT answer on FPort 3 is a reply: "type":"resp", the text, and its
// NAME=value lines as values. AT+ALL sends many lines, several per uplink ('\n' between),
// from ALL=START to ALL=END; a name that comes more than once (MODREAD, ANGREAD,
// AT+ALMCHECK) gives a list. "AT+A=1;AT+B=2" in one downlink answers SET=OK,<count>
// or SET=ERR,<number>,<answer>.
function decodeAtReply(bytes) {
    var text = bytesToText(bytes);
    var values = {};
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var eq = lines[i].indexOf("=");
        if (eq <= 0) {
            continue;
        }
        var key = lines[i].substring(0, eq).replace(/^AT\+/, "").trim();
        var val = lines[i].substring(eq + 1).trim();
        if (values[key] === undefined) {
            values[key] = val;
        } else if (Array.isArray(values[key])) {
            values[key].push(val);
        } else {
            values[key] = [values[key], val];
        }
    }
    return { type: "resp", atReply: text, values: values };
}

// =====================================================================
// V5.4: SAMPLING (FPort 3) and its settings echo (FPort 21), LX2 firmware
// V1.0.1 as the LX1 board (copied from the LX1 codec), in the layout of the
// MacSync LBS-STD-X1 node
//   [0] readings n   [1] source 0 RS485, 1 analog   [2] input 1 or 2
//   [3] its type     n floats, 4 bytes each, big endian
//   then 0xFF (the node's battery byte) and the UTC time stamp: 9 + 4 n bytes
// type: the RS485 field's data type, or the analog channel's mode.
// An AT answer on FPort 3 is text and never has this exact layout.
// =====================================================================

var MODBUS_FUNCTIONS = ["", "coils", "discrete inputs", "holding registers", "input registers"];
var SAMPLING_DATA_TYPES = ["int16", "uint16", "int32", "int32 CDAB",
    "float", "float CDAB"];
var SAMPLING_ANALOG_MODES = ["off", "current mA", "voltage V", "digital 1/0"];

function isSamplingBatch(bytes) {
    var n = bytes[0];
    if (bytes.length < 9 || n < 2 || n > 12 || bytes[1] > 1 || bytes[2] > 2) {
        return false;
    }
    return bytes.length === (bytes[2] === 0 ? 10 + 8 * n : 9 + 4 * n);
}

function samplingInput(bytes, source, input, type, at, n) {
    var out = {};
    var samples = [];
    for (var k = 0; k < n; k++) {
        var p = at + 4 * k;
        samples.push(parseFloat(GetFloat(bytes.slice(p, p + 4), 1).toFixed(3)));
    }
    if (source === 1) {
        out.channel = (input === 1) ? "A" : "B";
        out.mode = SAMPLING_ANALOG_MODES[type] || "unknown";
    } else {
        out.field = input;
        out.dataType = SAMPLING_DATA_TYPES[type] || "unknown";
    }
    out.samples = samples;
    return out;
}

function decodeSamplingBatch(bytes) {
    var n = bytes[0];
    var source = bytes[1];
    var out = {
        messageType: "Sampling",
        source: (source === 1) ? "analog" : "rs485",
        sampleCount: n
    };
    if (bytes[2] === 0) { // "both": LX1 firmware of 22 - 27 Oct 2026 only
        out.inputs = [
            samplingInput(bytes, source, 1, bytes[3], 5, n),
            samplingInput(bytes, source, 2, bytes[4], 5 + 4 * n, n)
        ];
    } else {
        out.inputs = [samplingInput(bytes, source, bytes[2], bytes[3], 4, n)];
    }
    out.Systimestamp = readTimestamp(bytes);
    return out;
}

// Settings echo, the answer to a port 21 downlink:
//   [0] input 0 field / channel 1, 1 field / channel 2   [1] readings per uplink
//   [2] enable   [3] source 0 RS485, 1 analog   [4,5] seconds between readings   [6] 0xFF
function decodeSamplingEcho(bytes) {
    var analog = bytes[3] === 1;
    var input = "both";
    if (bytes[0] !== 2) {
        input = analog ? ("channel " + (bytes[0] === 1 ? "B" : "A")) :
            ("field " + (bytes[0] + 1));
    }
    return {
        messageType: "Sampling settings",
        source: analog ? "analog" : "rs485",
        input: input,
        sampleCount: bytes[1],
        enable: bytes[2],
        interval: readUint16(bytes, 4)
    };
}

// V5.2: bytes of an ASCII text, for example the answer to an AT command.
function bytesToText(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i++) {
        text += String.fromCharCode(bytes[i]);
    }
    return text;
}

// 3 Nov 2026: "type" first in every decoded uplink: "resp" for a reply to a downlink
// (FPort 3 AT answers, response frames), "up" for everything else
function Decoder(bytes, port) {
    var decode = { type: "up" };
    if (Number(port) === 3 && bytes && isSamplingBatch(bytes)) { // V5.4: sampling readings
        decode.sampling = decodeSamplingBatch(bytes);
        return decode;
    }
    if (Number(port) === 21 && bytes && bytes.length === 7) { // V5.4: its settings echo
        decode.type = "resp";
        decode.samplingConfig = decodeSamplingEcho(bytes);
        return decode;
    }
    if (Number(port) === 3 && bytes && bytes.length > 0) {
        return decodeAtReply(bytes);
    }
    // V5.4: ADR (17), message type (18), ADR + SF + type (19) answers, as LX1
    if ((Number(port) === 17 || Number(port) === 18) && bytes && bytes.length === 2) {
        decode.lorawanConfig = Number(port) === 17 ?
            { messageType: "ADR setting", adr: bytes[0] === 1 ? "ON" : "OFF" } :
            { messageType: "Message type setting", msgtype: bytes[0] === 1 ? "CONFIRMED" : "UNCONFIRMED" };
        return decode;
    }
    if (Number(port) === 19 && bytes && bytes.length === 4) {
        decode.lorawanConfig = {
            messageType: "LoRaWAN settings",
            adr: bytes[0] === 1 ? "ON" : "OFF",
            sf: bytes[1],
            msgtype: bytes[2] === 1 ? "CONFIRMED" : "UNCONFIRMED"
        };
        return decode;
    }
    if (!bytes || bytes.length < 2) {
        return decode;
    }
    if (Number(port) === 4) { // controller relay event, own layout
        decode.relayEvent = decodeRelayEvent(bytes);
        return decode;
    }
    if (Number(port) === 3) { // V5.2: answer to an AT command (text)
        return decodeAtReply(bytes);
    }
    var parser = getParser(bytes[1]);
    if (!parser) {
        return decode;
    }
    switch (bytes[0]) {
        case 0:
            decode.boot = parser(bytes);
            break;
        case 1:
            decode.deviceinfo = getDeviceinfo(bytes, port);
            decode.devicedata = parser(bytes);
            break;
        case 2:
            decode.type = "resp";
            decode.responce = parser(bytes);
            break;
        case 3:
            decode.alarm = parser(bytes);
            break;
        case 4:
            decode.samples = parser(bytes);
            break;
        default:
            break;
    }
    return decode;
}

// =====================================================================
// RELAY EVENT (FPort 4): sent by a controller when its relay schedule
// switches a relay ON or OFF
//   [0] 0x01 relay change   [1] application type 0 single, 1 three phase
//   [2] relay 1 0/1 (three phase: 1 after START, 0 after STOP)
//   [3] relay 2 0/1 (0xFF in three phase)
//   [4] changed: bit 0 relay 1, bit 1 relay 2   [5] cause: 1 schedule
//   [6] slot 0-9 holding relay 1 ON (0xFF none)  [7] its type
//   [8] slot holding relay 2 ON                  [9] its type
//       type: 1 regular, 2 cyclic, 3 trigger
//   [10..13] time stamp, UTC
// Firmware from 19 Oct 2026 adds one 11-byte reason block per relay
// (relay 1 at [14], relay 2 at [25], 36 bytes in all):
//   [0] reason, see RELAY_REASONS (0 = relay not changed)
//   [1] trigger field (RS485 1-20, analog channel 1-2)
//   [2] trigger condition, see TRIGGER_CONDITIONS (0xFF = no trigger)
//   [3..6] trigger value x 100, [7..10] threshold x 100
//          (signed 32 bit, big endian, -2147483648 = none)
//   For a relay that has just gone OFF, [6..9] name the schedule that
//   held it ON (older firmware sends 0xFF, "none").
// =====================================================================

var SCHEDULE_TYPES = ["none", "regular", "cyclic", "trigger", "delay cyclic"];

// V5.4: relays of a schedule ("relayStatus"): 0 relay 1, 1 relay 2, 2 both
// (codec V5.1), any other value a bit mask, bit 0 = relay 1 ... bit 7 = relay 8
// (LX2; a motor through its START relay 2n-1). Returns "1,3,4".
function scheduleRelays(code) {
    if (code === 0) { return "1"; }
    if (code === 1) { return "2"; }
    if (code === 2) { return "1,2"; }
    return bitList(code);
}

// "1,3,4" for the set bits (bit 0 = 1), "none"
function bitList(mask) {
    var list = [];
    for (var b = 0; b < 8; b++) {
        if ((mask & (1 << b)) !== 0) { list.push(b + 1); }
    }
    return list.length ? list.join(",") : "none";
}

// V5.4: trigger source: 1-20 an RS485 field, 101-104 analog input A1-A4 (LX2)
function triggerSource(field) {
    if (field >= 101 && field <= 104) {
        return "analog input A" + (field - 100);
    }
    return "field" + field;
}

function scheduleRef(slot, type) {
    if (slot === 0xFF) {
        return "none";
    }
    return { slot: slot, type: SCHEDULE_TYPES[type] || "unknown" };
}

var RELAY_REASONS = ["not changed", "schedule ON time", "schedule OFF time",
    "trigger condition met", "trigger condition no longer met",
    "trigger sensor not answering", "trigger time window ended"];
var TRIGGER_CONDITIONS = ["greater than", "less than", "between"];
var NO_VALUE = -2147483648;

function readInt32(bytes, i) {
    return (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) |
        bytes[i + 3];
}

// Adds relay<n>Reason and, for a trigger schedule, relay<n>Trigger from the
// reason block at bytes[i].
function addRelayReason(ev, n, bytes, i, maxAt) {
    var reason = bytes[i];
    if (reason === 0) {
        return;
    }
    ev["relay" + n + "Reason"] = RELAY_REASONS[reason] || "unknown";
    if (bytes[i + 2] !== 0xFF) {
        var value = readInt32(bytes, i + 3);
        var threshold = readInt32(bytes, i + 7);
        var trigger = {
            field: bytes[i + 1],
            condition: TRIGGER_CONDITIONS[bytes[i + 2]] || "unknown",
            value: value === NO_VALUE ? "none" : value / 100
        };
        var max = (maxAt >= 0 && bytes.length >= maxAt + 4) ? readInt32(bytes, maxAt) : NO_VALUE;
        if (bytes[i + 2] === 2 && max !== NO_VALUE) {
            // between the user's Min and Max (LX2 firmware 1.0.0, as LX1)
            trigger.min = threshold / 100;
            trigger.max = max / 100;
        } else if (threshold !== NO_VALUE) {
            trigger.threshold = threshold / 100;
        }
        ev["relay" + n + "Trigger"] = trigger;
    }
}

function decodeRelayEvent(bytes) {
    var ev = {};
    ev.messageType = "Relay Event";
    if (bytes[0] !== 1 || bytes.length < 14) {
        ev.event = "unknown";
        return ev;
    }
    var three = bytes[1] === 1;
    ev.event = "relay_change";
    ev.cause = bytes[5] === 1 ? "schedule" : "unknown";
    ev.applicationType = three ? "Three Phase" : "Single Phase";
    ev.relay1 = bytes[2];
    ev.relay1Changed = (bytes[4] & 0x01) !== 0;
    ev.relay1Schedule = scheduleRef(bytes[6], bytes[7]);
    var reasons = bytes.length >= 36;
    if (reasons) {
        addRelayReason(ev, 1, bytes, 14, 38);
    }
    if (three) {
        ev.motor = bytes[2] === 1 ? "START" : "STOP";
    } else {
        ev.relay2 = bytes[3];
        ev.relay2Changed = (bytes[4] & 0x02) !== 0;
        ev.relay2Schedule = scheduleRef(bytes[8], bytes[9]);
        if (reasons) {
            addRelayReason(ev, 2, bytes, 25, 42);
        }
    }
    if (bytes.length >= 38) { // V5.4, LX2: relays 1-8 and the changed ones
        ev.relays = bitList(bytes[36]);
        ev.changedRelays = bitList(bytes[37]);
        for (var r = 3; r <= 8; r++) {
            ev["relay" + r] = (bytes[36] >> (r - 1)) & 1;
        }
    }
    ev.Systimestamp = readUint32(bytes, 10);
    return ev;
}

// V5.3: relays 3-8 of the MacSet-L LX2 board, 3 bytes
//   [0xD7] [0xC0 | relays 3-7, bit 0 = relay 3] [0xC0 | relay 8 | motors 2-4 << 1]
// (motor n on relays 2n-1 START / 2n STOP enabled: bit n-1 of the last byte, n = 2..4;
// motor 1 is the application type byte of the controller block)
// in front of the controller block of a periodic frame and behind relay 2
// in the port 5 response. Returns the relay 3-8 bits (bit 0 = relay 3), or
// -1 when the frame has no such block (LX1 and older firmware).
var RELAY_EXT_MARK = 0xD7;

function relayExtAt(bytes, i) {
    if (i < 2 || i + 2 >= bytes.length || bytes[i] !== RELAY_EXT_MARK ||
        (bytes[i + 1] & 0xE0) !== 0xC0 || (bytes[i + 2] & 0xF0) !== 0xC0) {
        return -1;
    }
    return (bytes[i + 1] & 0x1F) | ((bytes[i + 2] & 0x01) << 5);
}

// V5.3: "1,3" for motors 1 and 3, "none"
function motorList(motors) {
    var list = [];
    for (var k = 1; k <= 4; k++) {
        if ((motors >> (k - 1)) & 1) {
            list.push(k);
        }
    }
    return list.length ? list.join(",") : "none";
}

// Periodic frame of a controller: the block sits just before the controller
// block (3 bytes) and the time stamp (4 bytes)
function periodicRelayExt(bytes) {
    return isController(bytes[1]) ? relayExtAt(bytes, bytes.length - 10) : -1;
}

// relay<n>: 0 / 1 for relays 3-8 into out (key prefix as in the caller)
// Motors 2-4 enabled (bit 1 = motor 2 ... bit 3 = motor 4), from the block at bytes[i]
function relayExtMotors(bytes, i) {
    return bytes[i + 2] & 0x0E;
}

// relay<n> for relays 3-8 into out; a pair that is a motor starter is reported as
// motor<k> (its START relay: 1 / "on" = running) instead of its two relays
function addRelays3to8(out, ext, prefix, suffix, onOff, motors) {
    for (var r = 3; r <= 8; r++) {
        var k = (r + 1) >> 1;          // motor of the pair of relay r
        var on = (ext >> (r - 3)) & 1;
        if ((motors >> (k - 1)) & 1) {
            if (r & 1) {
                out[(onOff ? "motor" + k + "Status" : "motor" + k)] = onOff ? (on ? "on" : "off") : on;
            }
            continue;
        }
        out[prefix + r + suffix] = onOff ? (on ? "on" : "off") : on;
    }
}

function getParser(deviceType) {
    switch (deviceType) {
        case 0:
        case 2:
            return getRS485Data;
        case 1:
        case 3:
            return getAnalogData;
        case 4:
            return getCombinedData;
        case 16:
            return getMacSenseData;
        default:
            return null;
    }
}

// Common block of a periodic frame. Nodes send a battery byte (x10) just
// before the time stamp. Controllers are mains powered and send no
// battery byte: the byte there is a relay state, so it is not reported.
function getDeviceinfo(bytes, port) {
    var devInfo = {};
    devInfo.manufacturer = "Macnman India";
    devInfo.protocall = "LoRaWAN";
    devInfo.uplinkPort = port;
    devInfo.deviceID = bytes[1];
    if (!isController(bytes[1])) {
        devInfo.battery = bytes[bytes.length - 5] / 10;
    }
    devInfo.Systimestamp = readTimestamp(bytes);
    return devInfo;
}

// =====================================================================
// BOOT FRAME (frame type 0), 18 bytes
//   [0] 0x00   [1] device type
//   [2..5]   chip identity (company ID 3 bytes + device ID)
//   [6..8]   controllers: hardware version   nodes: firmware version
//   [9..11]  controllers: firmware version   nodes: hardware version
//   [12,13]  uplink interval, seconds (65535: 65535 s or longer)
//   [14..17] time stamp
// =====================================================================

function decodeBootMessage(bytes) {
    var boot_data = {};
    boot_data.messageType = "Boot Message";
    boot_data.OEM_ID = str_pad(bytes[2]) + str_pad(bytes[3]) +
        str_pad(bytes[4]) + str_pad(bytes[5]);
    // versions as plain numbers, "1.0.0", as in the SHT40 codec
    var first = bytes[6] + "." + bytes[7] + "." + bytes[8];
    var second = bytes[9] + "." + bytes[10] + "." + bytes[11];
    if (isController(bytes[1])) {
        boot_data.FR = second;
        boot_data.HW = first;
    } else {
        boot_data.FR = first;
        boot_data.HW = second;
    }
    // uplink interval in seconds; the frame has 2 bytes, so an interval
    // above 65535 s (up to 86400, firmware from 14 Oct 2026) shows as 65535
    boot_data.TDCM = readUint16(bytes, 12);
    boot_data.Systimestamp = readUint32(bytes, 14);
    return boot_data;
}

// Controller block of a periodic frame, just before the time stamp:
//   [application type 0 single / 1 three phase] [relay 1]
//   [relay 2, or 0xFF in three phase]
// V5.3: LX2 boards also report relays 3-8 (r3Status ... r8Status); they
// work as normal relays in three phase too.
function decodeControllerTail(bytes) {
    var n = bytes.length;
    var appType = bytes[n - 7];
    var controller = {};
    var ext = periodicRelayExt(bytes);
    controller.appType = appType ? "Three Phase" : "Single Phase";
    if (appType === 0) {
        controller.r1Status = bytes[n - 6] ? "on" : "off";
        controller.r2Status = bytes[n - 5] ? "on" : "off";
    } else {
        controller.status = bytes[n - 6] ? "on" : "off";
    }
    if (ext >= 0) {
        var motors = relayExtMotors(bytes, n - 10) | (appType ? 1 : 0);
        addRelays3to8(controller, ext, "r", "Status", true, motors);
        controller.motors = motorList(motors);
        if (appType) { // V5.4: motor 1 by name too, as motors 2-4 ("status" kept)
            controller.motor1Status = controller.status;
        }
    }
    return controller;
}

// =====================================================================
// ANALOG NODE (1) AND ANALOG CONTROLLER (3)
// =====================================================================

function getAnalogData(bytes) {
    if (bytes[0] === 0) {
        return decodeBootMessage(bytes);
    } else if (bytes[0] === 1) {
        return decodeAnalogPayload(bytes);
    } else if (bytes[0] === 4) {
        return decodeAnalogAlarm(bytes);
    }
}

// Periodic frame. Per channel: [mode], then [value hi][value lo] unless
// the mode is 0.
//   mode 0 disabled
//   mode 1 current, sent in uA, reported in mA
//   mode 2 voltage, sent in mV, reported in V
//   mode 3 digital level, sent as a voltage in mV, HIGH above 1.8 V
//          (the same threshold as AT+ANGCHECK in the controller)
// Controller: the channels are followed by the controller block and the
// time stamp. Node: by a battery byte and the time stamp (V5.0 layout).
function decodeAnalogPayload(bytes) {
    var analog_data = {};
    analog_data.messageType = "Payload";
    analog_data.analogData = {};
    var lastIndex = bytes[1] <= 1 ? (bytes.length - 5) : (bytes.length - 8);
    if (periodicRelayExt(bytes) >= 0) {
        lastIndex -= 3;     // V5.3: relays 3-8 block of the LX2 board
    }
    var channel = 0;
    for (var i = 2; i <= lastIndex; i++) {
        var name = "channel_" + String.fromCharCode(97 + channel);
        switch (bytes[i]) {
            case 0:
                analog_data.analogData[name] = "disabled";
                break;
            case 1:
                analog_data.analogData[name + "_current"] = readUint16(bytes, i + 1) / 1000;
                i += 2;
                break;
            case 2:
                analog_data.analogData[name + "_voltage"] = readUint16(bytes, i + 1) / 1000;
                i += 2;
                break;
            case 3:
                analog_data.analogData[name + "_level"] =
                    (readUint16(bytes, i + 1) / 1000) > 1.8 ? "HIGH" : "LOW";
                i += 2;
                break;
            default:
                break;
        }
        channel++;
    }
    if (bytes[1] === 3) {
        analog_data.controller = decodeControllerTail(bytes);
    }
    return analog_data;
}

// Set point of an analog trigger: [mode] then the value as above.
function readAnalogSetPoint(bytes, i, out, key) {
    switch (bytes[i]) {
        case 0:
            out[key] = "disabled";
            return i;
        case 1:
        case 2:
            out[key] = readUint16(bytes, i + 1) / 1000;
            return i + 2;
        case 3:
            out[key] = (readUint16(bytes, i + 1) / 1000) > 1.8 ? "HIGH" : "LOW";
            return i + 2;
        default:
            return i;
    }
}

// Analog alarm frame (frame type 4), V5.0 layout, not used by the
// controllers. Per trigger: 0x0A error, 0x0B disabled, otherwise
// [T][set point mode + value][T].
function decodeAnalogAlarm(bytes) {
    var trigger_data = {};
    var i = 2;
    trigger_data.messageType = "Alarm";
    if (bytes[i] === 0x0A) {
        trigger_data.Trigger1 = "Error";
    } else if (bytes[i] === 0x0B) {
        trigger_data.Trigger1 = "Disabled";
    } else {
        trigger_data.T1 = bytes[i];
        i = readAnalogSetPoint(bytes, i + 1, trigger_data, "setPoint1");
        trigger_data.T2 = bytes[++i];
    }
    ++i; // second trigger
    if (bytes[i] === 0x0A) {
        trigger_data.Trigger2 = "Error";
    } else if (bytes[i] === 0x0B) {
        trigger_data.Trigger2 = "Disabled";
    } else {
        trigger_data.T3 = bytes[i];
        i = readAnalogSetPoint(bytes, i + 1, trigger_data, "setPoint2");
        trigger_data.T4 = bytes[++i];
    }
    return trigger_data;
}

// =====================================================================
// V5.3: RS485 + ANALOG CONTROLLER (4), MacSet-L LX2
// Periodic frame: [0x01][0x04]
//   4 analog channels, each [mode] + [value hi][value lo] unless mode 0
//     (modes as in the analog frame: 0 disabled, 1 current uA, 2 voltage mV,
//      3 digital level, HIGH above 1.8 V)
//   Modbus fields 1-20 as in the RS485 frame (as many as fit the data rate)
//   relays 3-8 block, controller block, time stamp
// Output: analogData (channel_a ... channel_d) and field1 ... fieldN, controller.
// =====================================================================

var COMBINED_CHANNELS = 4;

function getCombinedData(bytes) {
    if (bytes[0] === 0) {
        return decodeBootMessage(bytes);
    } else if (bytes[0] === 1) {
        return decodeCombinedPayload(bytes);
    }
    return "Error";
}

function decodeCombinedPayload(bytes) {
    var data = {};
    var i = 2;
    data.messageType = "Payload";
    data.analogData = {};
    for (var ch = 0; ch < COMBINED_CHANNELS; ch++) {
        var name = "channel_" + String.fromCharCode(97 + ch);
        var mode = bytes[i++];
        if (mode === 0) {
            data.analogData[name] = "disabled";
            continue;
        }
        var raw = readUint16(bytes, i);
        i += 2;
        if (mode === 1) { // V5.4: uA -> mA, 0.1 mA as the Maya app shows it
            data.analogData[name + "_current"] = Math.round(raw / 100) / 10;
        } else if (mode === 2) { // V5.4: mV -> V, 0.01 V
            data.analogData[name + "_voltage"] = Math.round(raw / 10) / 100;
        } else if (mode === 3) {
            data.analogData[name + "_level"] = (raw / 1000) > 1.8 ? "HIGH" : "LOW";
        } else {
            data.analogData[name] = "unknown mode " + mode;
        }
    }
    var lastIndex = bytes.length - 8;
    if (periodicRelayExt(bytes) >= 0) {
        lastIndex -= 3;
    }
    decodeModbusFields(bytes, i, lastIndex, data);
    data.controller = decodeControllerTail(bytes);
    return data;
}

// =====================================================================
// RS485 NODE (0) AND RS485 CONTROLLER (2)
// =====================================================================

function getRS485Data(bytes) {
    if (bytes[0] === 0) {
        return decodeBootMessage(bytes);
    } else if (bytes[0] === 1) {
        return decodeUplinkBytes(bytes);
    } else if (bytes[0] === 2) {
        return decodeResponce(bytes);
    } else if (bytes[0] === 3) {
        return decodeAlarm(bytes);
    }
    return "Error";
}

// Field header byte: bits 7..5 data type, bits 4..0 number of values.
function decodeByte(encodedByte) {
    return {
        dataType: (encodedByte >> 5) & 0x07,
        numRegisters: encodedByte & 0x1F
    };
}

// Modbus field list in bytes[start..end]. Each field is a header byte,
// then its values:
//   type 0 int16, 1 uint16 (2 bytes per value)
//   type 2 int32 ABCD, 3 int32 CDAB, 4 float ABCD, 5 float CDAB (4 bytes)
//   type 6 field disabled, 7 slave error (no value bytes)
// The fields are written into result as field1, field2, ...
function decodeModbusFields(bytes, start, end, result) {
    var fieldIndex = 1;
    for (var i = start; i <= end; i++) {
        var key = "field" + fieldIndex;
        var header = decodeByte(bytes[i]);
        var count = header.numRegisters;
        var params = [];
        var k;
        switch (header.dataType) {
            case 0:
                for (k = 0; k < count; k++) {
                    params.push(readInt16(bytes, i + 1));
                    i += 2;
                }
                result[key] = (count === 1) ? params[0] : params;
                break;
            case 1:
                for (k = 0; k < count; k++) {
                    params.push(readUint16(bytes, i + 1));
                    i += 2;
                }
                result[key] = (count === 1) ? params[0] : params;
                break;
            case 2:
            case 3:
                for (k = 0; k < count; k++) {
                    params.push(parseFloat(GetLongInt(
                        [bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]],
                        header.dataType === 3 ? 0 : 1).toFixed(3)));
                    i += 4;
                }
                result[key] = (count === 1) ? params[0] : params;
                break;
            case 4:
            case 5:
                for (k = 0; k < count; k++) {
                    params.push(parseFloat(GetFloat(
                        [bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]],
                        header.dataType === 5 ? 0 : 1).toFixed(3)));
                    i += 4;
                }
                result[key] = (count === 1) ? params[0] : params;
                break;
            case 6:
                result[key] = "Disabled";
                break;
            case 7:
                result[key] = "Slave Error";
                break;
            default:
                break;
        }
        fieldIndex++;
    }
    return result;
}

// Periodic frame: [0x01][device type] + 20 fields + (controller block or
// battery byte) + time stamp.
// NOTE: for a field read with Modbus function 1 or 2 (coils, discrete
// inputs) the controller sends one byte per coil byte, but this layout
// expects 2 bytes per value, so such fields do not decode correctly.
// The port 13 response sends 2 bytes per coil byte and is fine.
function decodeUplinkBytes(bytes) {
    var rs485_data = {};
    rs485_data.messageType = "Payload";
    var lastIndex = bytes[1] <= 1 ? bytes.length - 6 : bytes.length - 8;
    if (periodicRelayExt(bytes) >= 0) {
        lastIndex -= 3;     // V5.3: relays 3-8 block of the LX2 board
    }
    decodeModbusFields(bytes, 2, lastIndex, rs485_data);
    if (bytes[1] === 2) {
        rs485_data.controller = decodeControllerTail(bytes);
    }
    return rs485_data;
}

// =====================================================================
// RESPONSE FRAME (frame type 2): answer to a downlink
//   [0] 0x02  [1] 0x02  [2] downlink port  [3] state (0 = OK)
//   [4..]  port specific   last 4 bytes: time stamp (UTC)
// =====================================================================

function decodeResponce(bytes) {
    var responceData = {};
    responceData.messageType = "Responce";
    responceData.portNumber = bytes[2];
    responceData.status = bytes[3] === 0 ? "SUCCSESS" : "ERROR";
    if (responceData.status !== "SUCCSESS") {
        return responceData;
    }
    switch (responceData.portNumber) {
        case 5: // relay control: [4] application type [5] relay 1 [6] relay 2
            responceData.applicationType = bytes[4] === 0 ? "Single Phase" : "Three Phase";
            responceData.relay1 = bytes[5];
            responceData.relay2 = bytes[6];
            var ext = relayExtAt(bytes, 7);   // V5.3: LX2, relays 3-8 and motors 2-4
            if (ext >= 0) {
                addRelays3to8(responceData, ext, "relay", "", false,
                    relayExtMotors(bytes, 7) | (bytes[4] ? 1 : 0));
            }
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 6: // uplink interval: [4,5] seconds, or [4..7] when the
                // downlink had 4 bytes (firmware from 14 Oct 2026)
            responceData.txTime = bytes.length >= 12 ?
                readUint32(bytes, 4) : readUint16(bytes, 4);
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 8: // Modbus write. The controller answers a port 9 register
        case 9: // write with port 8 in byte [2] as well.
            // [4] slave ID [5] number of registers [6,7] address [8..] value
            responceData.slaveId = bytes[4];
            responceData.numberofreg = bytes[5];
            responceData.address = readUint16(bytes, 6);
            // The value is 2 or 4 bytes: take the size from the frame. The
            // controller always sends 2 bytes, the low 16 bits of the value.
            if (bytes[5] > 2 && bytes.length - 12 === 2 * bytes[5]) {
                // V5.4, LX2 V1.0.7: several registers, one value each
                responceData.values = [];
                for (var ri = 0; ri < bytes[5]; ri++) {
                    responceData.values.push(readUint16(bytes, 8 + 2 * ri));
                }
            } else {
                responceData.value = (bytes.length - 12 >= 4) ?
                    readUint32(bytes, 8) : readUint16(bytes, 8);
                if (bytes[5] > 2 && bytes[5] <= 16 && bytes.length - 12 === 4) {
                    // several coils: their states, first coil first
                    responceData.values = [];
                    for (var cb = 0; cb < bytes[5]; cb++) {
                        responceData.values.push((responceData.value >>> cb) & 1);
                    }
                    delete responceData.value;
                }
            }
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 10: // Modbus field stored (port 10) or read back (port 15)
            // [4] field [5] slave [6] function [7] enable [8] data type
            // [9] number of values [10,11] register address, then the name (LX2)
            // V5.4: the names of the LX1 codec, plus the field's name (LX2)
            responceData.field = bytes[4];
            responceData.slaveId = bytes[5];
            responceData.functionCode = bytes[6];
            responceData.enable = bytes[7];
            responceData.dataType = bytes[8];
            responceData.numberOfResistors = bytes[9];
            responceData.address = readUint16(bytes, 10);
            if (bytes.length > 16) {
                responceData.parameterName = bytesToText(bytes.slice(12, bytes.length - 4));
            }
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 11: // alarm stored (port 11) or read back (port 14)
            // [4] slot [5..8] start [9..12] stop (seconds from midnight)
            // [13] days [14] relay [15] type [16] enable, then
            // type 2: [17..20] ON s [21..24] OFF s
            // type 3: [17..20] threshold [21] level [22] field
            // V5.4: the names of the LX1 codec
            responceData.index = bytes[4];
            responceData.startTime = readUint32(bytes, 5);
            responceData.stopTime = readUint32(bytes, 9);
            responceData.dayData = bytes[13];
            responceData.relayStatus = bytes[14];
            responceData.triggerType = bytes[15];
            responceData.enable = bytes[16];
            if (bytes[15] === 2) {
                responceData.onTime = readUint32(bytes, 17);
                responceData.offTime = readUint32(bytes, 21);
            } else if (bytes[15] === 3) {
                // LX2 firmware 1.0.0 (as LX1): x 100 with 2 decimals, between with Min / Max
                var x100 = bytes.length >= 31;
                responceData.sensorValue = x100 ? readInt32(bytes, 17) / 100 : (readUint32(bytes, 17) | 0);
                responceData.level = bytes[21];
                responceData.rs485Field = bytes[22];
                if (x100 && bytes[21] === 2) {
                    responceData.min = responceData.sensorValue;
                    responceData.max = readInt32(bytes, 23) / 100;
                }
            }
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 12: // RS485 baud rate: [4,5] baud [6] parity
            responceData.baudrate = readUint16(bytes, 4);
            responceData.parity = bytes[6];
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        case 13: // register read now: [4..] one field as in a periodic frame
            responceData.values = decodeModbusFields(bytes, 4, bytes.length - 5,
                { messageType: "Payload" });
            responceData.Systimestamp = readTimestamp(bytes);
            break;
        default:
            break;
    }
    return responceData;
}

// =====================================================================
// RS485 ALARM FRAME (frame type 3), V5.0 layout, not used by the
// controllers. Per trigger: 0x0A error, 0x0B disabled, otherwise
// [T 4 bytes][set point type + value][T 4 bytes].
// =====================================================================

function readRS485SetPoint(bytes, i, out, key) {
    switch (bytes[i]) {
        case 0:
            out[key] = readInt16(bytes, i + 1);
            return i + 2;
        case 1:
            out[key] = readUint16(bytes, i + 1);
            return i + 2;
        case 2:
        case 3:
            out[key] = parseFloat(GetLongInt(
                [bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]],
                bytes[i] === 3 ? 0 : 1).toFixed(3));
            return i + 4;
        case 4:
        case 5:
            out[key] = parseFloat(GetFloat(
                [bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]],
                bytes[i] === 5 ? 0 : 1).toFixed(3));
            return i + 4;
        case 10:
            out[key] = "Slave Error";
            return i;
        case 11:
            out[key] = "Disabled";
            return i;
        default:
            return i;
    }
}

function readLongAt(bytes, i) {
    return GetLongInt([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]], 1);
}

function decodeAlarm(bytes) {
    var trigger_data = {};
    var i = 2;
    trigger_data.messageType = "Alarm";
    if (bytes[i] === 0x0A) {
        trigger_data.Trigger1 = "Error";
    } else if (bytes[i] === 0x0B) {
        trigger_data.Trigger1 = "Disabled";
    } else {
        trigger_data.T1 = readLongAt(bytes, i);
        i = readRS485SetPoint(bytes, i + 4, trigger_data, "setPoint1");
        trigger_data.T2 = readLongAt(bytes, i + 1);
        i += 4;
    }
    ++i; // second trigger
    if (bytes[i] === 0x0A) {
        trigger_data.Trigger2 = "Error";
    } else if (bytes[i] === 0x0B) {
        trigger_data.Trigger2 = "Disabled";
    } else {
        trigger_data.T3 = readLongAt(bytes, i);
        i = readRS485SetPoint(bytes, i + 4, trigger_data, "setPoint2");
        trigger_data.T4 = readLongAt(bytes, i + 1);
    }
    return trigger_data;
}

// =====================================================================
// MACSENSE V2.0 (16), V5.0 layouts, not checked against firmware
// =====================================================================

function getMacSenseData(bytes) {
    if (bytes[0] === 0) {
        return decodeBootMessage(bytes);
    } else if (bytes[0] === 1) {
        return getSensorData(bytes);
    } else if (bytes[0] === 2) {
        return decodeResponce(bytes);
    } else if (bytes[0] === 3) {
        return decodeTrigerData(bytes);
    } else if (bytes[0] === 4) {
        return decodeSamplingData(bytes);
    }
}

// Sensor byte: bits 7..5 sensor code, bits 4..0 value type.
function getDataTypeAndSensor(encodedByte) {
    return {
        dataType: encodedByte & 0x1F,
        numRegisters: (encodedByte >> 5) & 0x07
    };
}

function getSensorData(bytes) {
    var sensorData = {};
    var b = bytes.slice(0, bytes.length - 5); // copy: battery + time stamp removed
    var i = 1;
    while (i < b.length - 1) {
        var decoded = getDataTypeAndSensor(b[++i]);
        var fieldName = SENSOR_FIELD_NAMES[decoded.numRegisters];
        switch (decoded.dataType) {
            case 0: // error
                sensorData[fieldName] = "Error";
                break;
            case 1: // int16: temperature and humidity / 100, pressure and level / 10
                if (fieldName === "temperature" || fieldName === "humidity") {
                    sensorData[fieldName] = parseFloat((readInt16(b, i + 1) / 100).toFixed(2));
                    i += 2;
                } else if (fieldName === "pressure" || fieldName === "level") {
                    sensorData[fieldName] = parseFloat((readInt16(b, i + 1) / 10).toFixed(2));
                    i += 2;
                }
                break;
            case 2:
                sensorData[fieldName] = parseFloat(readUint16(b, i + 1).toFixed(2));
                i += 2;
                break;
            case 3:
                sensorData[fieldName] = parseFloat((readUint16(b, i + 1) / 100).toFixed(2));
                i += 2;
                break;
            default:
                break;
        }
    }
    return sensorData;
}

function decodeTrigerData(bytes) {
    var triggerData = {};
    triggerData.threshould1 = parseFloat(GetFloatFromBytes(bytes.slice(2, 6), 1).toFixed(3));
    triggerData[SENSOR_FIELD_NAMES[bytes[6]]] =
        parseFloat(GetFloatFromBytes(bytes.slice(7, 11), 1).toFixed(3));
    triggerData.threshould2 = parseFloat(GetFloatFromBytes(bytes.slice(11, 15), 1).toFixed(3));
    return triggerData;
}

function decodeSamplingData(bytes) {
    var sampleData = {};
    var fieldIndex = 1;
    var lastIndex = bytes.length - 8;
    sampleData.parameter = SENSOR_FIELD_NAMES[bytes[2]];
    sampleData.noofsamples = bytes[3];
    var i = 3;
    while (i <= lastIndex) {
        var key = sampleData.parameter + fieldIndex++;
        if (bytes[i] !== 0xFF) {
            sampleData[key] = parseFloat(
                GetFloatFromBytes(bytes.slice(i + 1, i + 5), 1).toFixed(3));
            i += 4;
        } else {
            sampleData[key] = "Error";
            i += 1;
        }
    }
    sampleData.battery = bytes[i + 1] / 10;
    sampleData.Systimestamp = readUint32(bytes, i + 2);
    return sampleData;
}

// =====================================================================
// DOWNLINK ENCODER
// The FPort selects the command (controller firmware, OnRxData):
//    5  relay control, with response    relay1, relay2: 0 off, 1 on,
//                                       3 or missing: keep as it is
//    6  uplink interval                 txTime: 10 .. 86400 s; above
//                                       65535 s it goes out as 4 bytes,
//                                       which needs firmware from
//                                       14 Oct 2026
//    7  relay control, no response      as port 5; in three phase relay1
//                                       1 gives START, 0 gives STOP
//    8  Modbus coil write               slaveId, address, value (one coil)
//                                       or values [0/1, ...] (up to 16 coils)
//    9  Modbus register write           slaveId, address, value (one register)
//                                       or values [...] (up to 16 registers)
//   10  store a Modbus field            Field 1..20, slaveId, functionCode,
//                                       Enable, dataType, numberOfParameters,
//                                       Registeraddress
//   11  store an alarm                  slot 0..9, startTime, stopTime,
//                                       dayData, relayStatus, alarmType 1..3,
//                                       enable; type 2: onTime, offTime;
//                                       type 3: sensorValue, condition, rs485Field
//   12  RS485 baud rate and parity      baud 1200..65535, pairity 0..2
//   13  read a register now             slaveId, functionCode, dataType,
//                                       numberOfParameters, Registeraddress
//   14  read an alarm back              slot 0..9 ("index" still accepted)
//   15  read a Modbus field back        field_read 1..20
// A value out of range raises an error instead of sending a bad downlink.
// =====================================================================

function requireInt(value, name, min, max) {
    var v = Number(value);
    if (value === undefined || value === null || value === "" ||
        isNaN(v) || Math.floor(v) !== v || v < min || v > max) {
        throw new Error(name + " must be a whole number from " + min + " to " + max);
    }
    return v;
}

function pushUint16(bytes, value) {
    bytes.push((value >> 8) & 0xFF, value & 0xFF);
}

function pushUint32(bytes, value) {
    bytes.push((value >> 24) & 0xFF, (value >> 16) & 0xFF,
        (value >> 8) & 0xFF, value & 0xFF);
}

// First value that is not undefined: lets the old and the corrected key
// names both work ("pairity" / "parity", "condition" / "level").
// hex text ("01A2B3C4", also "01:A2:B3:C4") -> count bytes
function pushHexBytes(bytes, text, count, name) {
    var hex = String(text === undefined ? "" : text).replace(/[\s:-]/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length !== count * 2) {
        throw new Error(name + " must be " + count + " bytes in hex (" + (count * 2) + " hex digits)");
    }
    for (var i = 0; i < count; i++) {
        bytes.push(parseInt(hex.substr(i * 2, 2), 16));
    }
}

// V5.4: "relays":3 (one relay: its number 1-8) or "relays":[3,4] (several) -> the board's
// relay byte: relay 1 alone 0, relay 2 alone 1, relays 1+2 2, any other set a bit mask
// (bit 0 = relay 1 ... bit 7 = relay 8). The old "relayStatus" number is still accepted.
function scheduleRelayCode(data) {
    // V5.4: "relayStatus" (LX1 name): a number as on LX1 (0 relay 1, 1 relay 2, 2 both,
    // else a relay bit mask), or a list of relay numbers [3,4]; "relays" works too
    if (data.relays === undefined && !Array.isArray(data.relayStatus)) {
        return requireInt(data.relayStatus, "relayStatus", 0, 255);
    }
    var lv = data.relays !== undefined ? data.relays : data.relayStatus;
    var list = Array.isArray(lv) ? lv : [lv];
    var mask = 0;
    if (list.length < 1) {
        throw new Error("relays: one relay 1-8, or a list like [3,4]");
    }
    for (var ri = 0; ri < list.length; ri++) {
        mask |= 1 << (requireInt(list[ri], "relays", 1, 8) - 1);
    }
    if (mask === 1) { return 0; }
    if (mask === 2) { return 1; }
    if (mask === 3) { return 2; }
    return mask;
}

// V5.4: the days of a schedule by name. The board keeps them as bits: 0 = every day,
// else 1 Sun, 2 Mon, 4 Tue, 8 Wed, 16 Thu, 32 Fri, 64 Sat.
var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function scheduleDayCode(data) {
    // V5.4: "dayData" (LX1 name): a number as on LX1 (bits, 0 or 127 = every day), or
    // "all" / day names; "days" works the same
    var v = data.days !== undefined ? data.days : data.dayData;
    if (typeof v === "number" || /^\d+$/.test(String(v))) {
        return requireInt(v, "dayData", 0, 127);
    }
    if (String(v).toLowerCase() === "all") {
        return 0;
    }
    var list = Array.isArray(v) ? v : [v];
    var mask = 0;
    if (list.length < 1) {
        throw new Error("days: \"all\" or a list like [\"Mon\",\"Tue\"]");
    }
    for (var di = 0; di < list.length; di++) {
        var day = DAY_NAMES.indexOf(String(list[di]).slice(0, 1).toUpperCase() +
            String(list[di]).slice(1, 3).toLowerCase());
        if (day < 0) {
            throw new Error("days: Sun, Mon, Tue, Wed, Thu, Fri, Sat or \"all\"");
        }
        mask |= 1 << day;
    }
    return mask === 127 ? 0 : mask;
}

function scheduleDays(code) {
    if (code === 0 || (code & 127) === 127) {
        return "all";
    }
    var list = [];
    for (var di = 0; di < 7; di++) {
        if ((code & (1 << di)) !== 0) { list.push(DAY_NAMES[di]); }
    }
    return list;
}

// V5.4: schedule times as text. A clock time "06:00" (00:00-24:00, India time);
// the old seconds after midnight (21600) are still accepted.
function clockSeconds(value, name) {
    if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim())) {
        var hm = value.trim().split(":");
        var h = Number(hm[0]), m = Number(hm[1]);
        if (m < 60 && (h < 24 || (h === 24 && m === 0))) {
            return h * 3600 + m * 60;
        }
    } else if (typeof value === "number") {
        return requireInt(value, name, 0, 86400);
    }
    throw new Error(name + ": a time 00:00 to 24:00, e.g. \"06:00\"");
}

function clockText(seconds) {
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}

// A duration "10 min", "30 s", "2 h", "1 h 30 min" (up to 24 h); old seconds still accepted.
function durationSeconds(value, name) {
    if (typeof value === "number") {
        return requireInt(value, name, 0, 86400);
    }
    var text = String(value).trim().toLowerCase();
    var re = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g, part, total = 0, used = "";
    while ((part = re.exec(text)) !== null) {
        total += Number(part[1]) * (part[2][0] === "h" ? 3600 : part[2][0] === "m" ? 60 : 1);
        used += part[0];
    }
    if (used === "" || used.replace(/\s/g, "") !== text.replace(/\s/g, "") || total > 86400) {
        throw new Error(name + ": a time like \"10 min\", \"30 s\", \"2 h\" or \"1 h 30 min\" (up to 24 h)");
    }
    return total;
}

function durationText(seconds) {
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    var out = [];
    if (h) { out.push(h + " h"); }
    if (m) { out.push(m + " min"); }
    if (s || out.length === 0) { out.push(s + " s"); }
    return out.join(" ");
}

// V5.4: values as words instead of code numbers (the numbers still work)
var NAMES_FUNCTION = { "coils": 1, "discrete inputs": 2, "holding registers": 3, "input registers": 4 };
var NAMES_DATATYPE = { "int16": 0, "uint16": 1, "int32": 2, "int32 swapped": 3, "float": 4,
    "float swapped": 5, "off": 6 };
var NAMES_SCHEDULE = { "regular": 1, "cyclic": 2, "trigger": 3, "delay cyclic": 4 };
var NAMES_CONDITION = { "greater than": 0, "less than": 1, "between": 2 };
var NAMES_PARITY = { "none": 0, "even": 1, "odd": 2 };
var NAMES_INPUT = { "a1": 101, "a2": 102, "a3": 103, "a4": 104 };

function named(value, name, names, min, max) {
    if (typeof value === "string" && isNaN(Number(value))) {
        var key = value.trim().toLowerCase().replace(/\s+/g, " ");
        if (names.hasOwnProperty(key)) {
            return names[key];
        }
        throw new Error(name + ": one of " + Object.keys(names).map(function (k) {
            return "\"" + (k.length === 2 ? k.toUpperCase() : k) + "\"";
        }).join(", "));
    }
    return requireInt(value, name, min, max);
}

// V5.4: words in AT commands sent by downlink, turned into the numbers the board reads,
// e.g. "AT+ALMENB=1,06:00,18:00,Mon-Fri,relays 3+4,cyclic,on,10 min,30 min" ->
// "AT+ALMENB=1,06:00,18:00,62,12,2,1,600,1800". Numbers are passed on unchanged
// (as the Maya app sends them). Over Bluetooth the board needs the numbers.
var AT_WORDS = {
    onoff: { "on": "1", "off": "0" },
    startstop: { "start": "1", "stop": "0" },
    kind: { "disable": "0", "4-20ma": "1", "0-10v": "2", "digital": "3" },
    func: { "coils": "1", "discrete inputs": "2", "holding registers": "3", "input registers": "4" },
    dtype: { "int16": "0", "uint16": "1", "int32": "2", "int32 swapped": "3", "float": "4", "float swapped": "5" },
    sched: { "regular": "1", "cyclic": "2", "trigger": "3", "delay cyclic": "4" },
    cond: { "greater than": "0", "less than": "1" },
    watch: { "a1": "101", "a2": "102", "a3": "103", "a4": "104" },
    parity: { "none": "0", "even": "1", "odd": "2" },
    payfmt: { "macset": "0", "maya": "1", "codec": "2" },
    band: { "as923": "0", "au915": "1", "eu868": "2", "in865": "3", "us915": "4" },
    dr: { "sf12": "0", "sf11": "1", "sf10": "2", "sf9": "3", "sf8": "4", "sf7": "5" },
    field: { "field 1": "0", "field 2": "1", "field1": "0", "field2": "1" }
};

function atWord(table) {
    return function (v) {
        if (v === undefined) { return v; }
        var k = v.toLowerCase().replace(/\s+/g, " ");
        return AT_WORDS[table].hasOwnProperty(k) ? AT_WORDS[table][k] : v;
    };
}

function atDuration(v) {
    return (v !== undefined && /[a-z]/i.test(v)) ? String(durationSeconds(v, "time")) : v;
}

function atDays(v) {
    var t = v.toLowerCase().replace(/\s+/g, "");
    if (t === "all") { return "0"; }
    if (!/[a-z]/.test(t)) { return v; }
    var names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], mask = 0;
    t.split("+").forEach(function (part) {
        var span = part.split("-").map(function (d) { return names.indexOf(d.slice(0, 3)); });
        if (span.indexOf(-1) >= 0 || span.length > 2) {
            throw new Error("days: \"all\", \"Mon\", \"Mon+Wed\" or \"Mon-Fri\"");
        }
        for (var d = span[0]; ; d = (d + 1) % 7) {
            mask |= 1 << d;
            if (d === span[span.length - 1]) { break; }
        }
    });
    return String(mask === 127 ? 0 : mask);
}

function atRelayMask(v) {          // "relay 3", "relays 3+4" -> bit mask, else null
    var m = /^relays?\s*([1-8](\s*\+\s*[1-8])*)$/i.exec(v.trim());
    if (!m) { return null; }
    var mask = 0;
    m[1].split("+").forEach(function (r) { mask |= 1 << (Number(r) - 1); });
    return mask;
}

function atSchedRelays(v) {
    var mask = atRelayMask(v);
    return mask === null ? v : String(mask === 1 ? 0 : mask === 2 ? 1 : mask === 3 ? 2 : mask);
}

function atSeqRelays(v) {
    if (/^none$/i.test(v.trim())) { return "0"; }
    var mask = atRelayMask(v);
    return mask === null ? v : String(mask);
}

function atDateTime(v) {           // "2026-11-21 15:30" India time -> Unix seconds
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(v.trim());
    return m ? String(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - 19800) : v;
}

var AT_ARGS = {
    TXTIME: [atDuration], PAYFMT: [atWord("payfmt")], BAND: [atWord("band")],
    MSGINFO: [atWord("onoff"), atWord("dr"), atWord("onoff")],
    ADR: [atWord("onoff")], CFM: [atWord("onoff")], DR: [atWord("dr")],
    BAUD: [null, atWord("parity")],
    MODCONF: [null, null, atWord("func"), atWord("onoff"), atWord("dtype")],
    MBSCAN: [atWord("func")], MBREAD: [null, atWord("func")],
    ANG: [null, atWord("kind")], LTIME: [atDateTime],
    RELAYSET: [null, atWord("onoff"), atDuration], MOTOR: [null, atWord("startstop")],
    SCHED: [null, atWord("onoff")],
    ALMENB: [null, null, null, atDays, atSchedRelays, atWord("sched"), atWord("onoff")],
    SAMPLING: [atWord("field"), null, atWord("onoff"), atDuration], SAMPENB: [atWord("onoff")],
    RELAY: [], MOTORS: [], ALMSEQ: []
};

function friendlyAt(text) {
    var m = /^(AT\+([A-Za-z]+)=)(.*)$/.exec(text.trim());
    if (!m || !AT_ARGS.hasOwnProperty(m[2].toUpperCase())) { return text; }
    var name = m[2].toUpperCase(), rule = AT_ARGS[name], i;
    var a = m[3].split(",").map(function (x) { return x.trim(); });
    if (name === "MOTORS" && a.length === 1) {
        var phase = a[0].toLowerCase();
        a = phase === "three" ? ["1", "1", "1", "1"] : phase === "single" ? ["0", "0", "0", "0"] : a;
    } else if (name === "RELAY") {
        a = a.map(atWord("onoff"));
    } else if (name === "ALMSEQ") {
        for (i = 1; i < a.length; i++) { a[i] = (i % 2 === 1) ? atSeqRelays(a[i]) : atDuration(a[i]); }
    } else {
        for (i = 0; i < rule.length && i < a.length; i++) {
            if (rule[i]) { a[i] = rule[i](a[i]); }
        }
        if (name === "ALMENB" && a[5] === "2") {
            a[7] = atDuration(a[7]);
            a[8] = atDuration(a[8]);
        } else if (name === "ALMENB" && a[5] === "3") {
            a[8] = atWord("cond")(a[8]);
            a[9] = atWord("watch")(a[9]);
        }
    }
    return m[1] + a.join(",");
}

// V5.4: port 3 without AT text, as named values like the other ports:
//   {"fPort":3,"read":"heartbeat"}                       -> AT+TXTIME
//   {"fPort":3,"set":"heartbeat","time":"5 min"}         -> AT+TXTIME=300
//   {"fPort":3,"do":"delete schedule","slot":3}          -> AT+ALMDEL=3
function p3Text(v, name, min, max, re) {
    var t = v === undefined || v === null ? "" : String(v).trim();
    if (t.length < min || t.length > max || (re && !re.test(t))) {
        throw new Error(name + ": " + min + " to " + max + " characters" + (re ? ", no comma or =" : ""));
    }
    return t;
}
function p3OnOff(v, name) {
    if (v === 1 || v === "1" || String(v).toLowerCase() === "on") { return "1"; }
    if (v === 0 || v === "0" || String(v).toLowerCase() === "off") { return "0"; }
    throw new Error(name + ": \"on\" or \"off\" (or 1 / 0)");
}
function p3Word(v, name, table) {
    var w = atWord(table)(String(v === undefined ? "" : v));
    if (!/^\d+$/.test(w)) {
        throw new Error(name + ": one of " + Object.keys(AT_WORDS[table]).join(", "));
    }
    return w;
}
function p3Secs(v, name, min, max) {
    var t = typeof v === "number" ? v : durationSeconds(v, name);
    if (t < min || t > max) { throw new Error(name + ": " + min + " to " + max + " s"); }
    return String(t);
}
var P3_LABEL = /^[^,=]*$/;
var P3_READ = {
    "device info": "AT+DEVINFO", "name": "AT+NAME", "heartbeat": "AT+TXTIME", "uplink format": "AT+PAYFMT",
    "lorawan": "AT+LRS", "class": "AT+CLASS", "band": "AT+BAND", "radio": "AT+MSGINFO", "adr": "AT+ADR",
    "data rate": "AT+DR", "spreading factor": "AT+SF", "confirmed": "AT+CFM", "keys": "AT+ID",
    "deveui": "AT+DEUI", "joineui": "AT+APPEUI", "device address": "AT+DADDR", "multicast": "AT+MCAST",
    "fuota": "AT+OTA", "rs485": "AT+BAUD", "parity": "AT+PARITY", "slave id": "AT+SLVID",
    "application": "AT+MOTORS", "clock": "AT+LTIME", "relays": "AT+RSTATUS", "motors": "AT+MOTOR",
    "schedules": "AT+ALMCHECK", "slots": "AT+SLOTS", "schedule applications": "AT+ALMTAGS",
    "sampling": "AT+SAMPLING", "sampling switch": "AT+SAMPENB", "latest data": "AT+DEVDATA",
    "reported values": "AT+PARAMS", "firmware version": "AT+APVER", "lorawan version": "AT+LRVER",
    "radio version": "AT+RDVER", "supply voltage": "AT+BATT", "all settings": "AT+ALL",
    "field name": function (d) { return "AT+MODLABEL=" + requireInt(d.field, "field", 1, 20); },
    "field": function (d) { return "AT+MODREAD=" + requireInt(d.field, "field", 1, 20); },
    "field status": function (d) { return "AT+MODSTATUS=" + requireInt(d.field, "field", 1, 20); },
    "field check": function (d) { return "AT+MODCHECK=" + requireInt(d.field, "field", 1, 20); },
    "analog input": function (d) { return "AT+ANGREAD=" + requireInt(d.input, "input", 1, 4); },
    "analog check": function (d) { return "AT+ANGCHECK=" + requireInt(d.input, "input", 1, 4); },
    "calibration": function (d) { return "AT+ANGCAL=" + requireInt(d.input, "input", 1, 4); },
    "schedule": function (d) { return "AT+SCHED=" + requireInt(d.slot, "slot", 0, 9); },
    "schedule steps": function (d) { return "AT+ALMSEQ=" + requireInt(d.slot, "slot", 0, 9); },
    "find slaves": function (d) {
        var t = "AT+MBSCAN=" + p3Word(d.functionCode, "functionCode", "func") + "," +
            requireInt(d.Registeraddress, "Registeraddress", 0, 65535);
        if (d.firstSlave !== undefined) {
            t += "," + requireInt(d.firstSlave, "firstSlave", 1, 247) + "," + requireInt(d.lastSlave, "lastSlave", 1, 247);
        }
        return t;
    },
    "registers": function (d) {
        return "AT+MBREAD=" + requireInt(d.slaveId, "slaveId", 1, 247) + "," +
            p3Word(d.functionCode, "functionCode", "func") + "," +
            requireInt(d.Registeraddress, "Registeraddress", 0, 65535) + "," + requireInt(d.count, "count", 1, 16);
    }
};
var P3_SET = {
    "name": function (d) { return "AT+NAME=" + p3Text(d.name, "name", 4, 20); },
    "heartbeat": function (d) { return "AT+TXTIME=" + p3Secs(d.time, "time", 10, 86400); },
    "uplink format": function (d) { return "AT+PAYFMT=" + p3Word(d.format, "format", "payfmt"); },
    "class": function (d) {
        var c = String(d.class).toUpperCase();
        if (c !== "A" && c !== "C") { throw new Error("class: \"A\" or \"C\""); }
        return "AT+CLASS=" + c;
    },
    "band": function (d) { return "AT+BAND=" + p3Word(d.band, "band", "band"); },
    "radio": function (d) {
        return "AT+MSGINFO=" + p3OnOff(d.adr, "adr") + "," + p3Word(d.dataRate, "dataRate", "dr") + "," +
            p3OnOff(d.confirmed, "confirmed");
    },
    "adr": function (d) { return "AT+ADR=" + p3OnOff(d.adr, "adr"); },
    "data rate": function (d) { return "AT+DR=" + p3Word(d.dataRate, "dataRate", "dr"); },
    "spreading factor": function (d) { return "AT+SF=" + requireInt(d.sf, "sf", 7, 12); },
    "confirmed": function (d) { return "AT+CFM=" + p3OnOff(d.confirmed, "confirmed"); },
    "keys": function (d) {
        if (String(d.keys).toLowerCase() !== "new") { throw new Error("keys: \"new\""); }
        return "AT+ID=REFRESH";
    },
    "deveui": function (d) { return "AT+DEUI=" + p3Text(d.devEui, "devEui", 4, 23); },
    "joineui": function (d) { return "AT+APPEUI=" + p3Text(d.joinEui, "joinEui", 16, 23); },
    "appkey": function (d) { return "AT+APPKEY=" + p3Text(d.appKey, "appKey", 4, 47); },
    "multicast": function (d) {
        return "AT+MCAST=" + p3Text(d.address, "address", 8, 11) + "," + p3Text(d.networkKey, "networkKey", 32, 47) +
            "," + p3Text(d.appKey, "appKey", 32, 47);
    },
    "rs485": function (d) {
        return "AT+BAUD=" + requireInt(d.baud, "baud", 1200, 115200) + "," + p3Word(d.parity, "parity", "parity");
    },
    "parity": function (d) { return "AT+PARITY=" + p3Word(d.parity, "parity", "parity"); },
    "slave id": function (d) { return "AT+SLVID=" + requireInt(d.slaveId, "slaveId", 1, 247); },
    "field name": function (d) {
        return "AT+MODLABEL=" + requireInt(d.field, "field", 1, 20) + "," + p3Text(d.name, "name", 0, 15, P3_LABEL);
    },
    "field": function (d) {
        return "AT+MODCONF=" + requireInt(d.field, "field", 1, 20) + "," + requireInt(d.slaveId, "slaveId", 1, 247) +
            "," + p3Word(d.functionCode, "functionCode", "func") + "," + p3OnOff(pick(d.Enable, d.enable), "Enable") +
            "," + p3Word(d.dataType, "dataType", "dtype") + "," +
            requireInt(d.numberOfParameters, "numberOfParameters", 1, 8) + "," +
            (requireInt(d.Registeraddress, "Registeraddress", 0, 65535) + 1);
    },
    "analog input": function (d) {
        return "AT+ANG=" + requireInt(d.input, "input", 1, 4) + "," + p3Word(d.kind, "kind", "kind");
    },
    "calibration": function (d) {
        var v = Number(d.trueValue);
        if (isNaN(v) || (v !== 0 && v < 0.5)) { throw new Error("trueValue: 0, or 0.5 and more"); }
        return "AT+ANGCAL=" + requireInt(d.input, "input", 1, 4) + "," + v;
    },
    "application": function (d) {
        var p = String(d.phase).toLowerCase();
        if (p !== "single" && p !== "three") { throw new Error("phase: \"single\" or \"three\""); }
        return p === "three" ? "AT+MOTORS=1,1,1,1" : "AT+MOTORS=0,0,0,0";
    },
    "clock": function (d) {
        var t = atDateTime(String(d.time));
        if (!/^\d+$/.test(t)) { throw new Error("time: \"YYYY-MM-DD HH:MM\", India time"); }
        return "AT+LTIME=" + t;
    },
    "relays": function (d) {
        var v = [], last = 0, r;
        for (r = 1; r <= 8; r++) { if (d["relay" + r] !== undefined) { last = r; } }
        if (last === 0) { throw new Error("relays: relay1 ... relay8, \"on\" or \"off\""); }
        for (r = 1; r <= last; r++) {
            if (d["relay" + r] === undefined) {
                throw new Error("relays: give every relay from relay1 up to relay" + last);
            }
            v.push(p3OnOff(d["relay" + r], "relay" + r));
        }
        return "AT+RELAY=" + v.join(",");
    },
    "relay": function (d) {
        return "AT+RELAYSET=" + requireInt(d.relay, "relay", 1, 8) + "," + p3OnOff(d.state, "state") +
            (d.time !== undefined ? "," + p3Secs(d.time, "time", 1, 65535) : "");
    },
    "motor": function (d) {
        var st = String(d.state).toLowerCase();
        st = st === "start" || st === "1" ? "1" : st === "stop" || st === "0" ? "0" : "";
        if (st === "") { throw new Error("state: \"start\" or \"stop\""); }
        return "AT+MOTOR=" + requireInt(d.motor, "motor", 1, 4) + "," + st;
    },
    "schedule": function (d) {
        var type = named(d.alarmType, "alarmType", NAMES_SCHEDULE, 1, 4);
        var t = "AT+ALMENB=" + requireInt(d.slot, "slot", 0, 9) + "," + clockSeconds(d.startTime, "startTime") + "," +
            clockSeconds(d.stopTime, "stopTime") + "," + scheduleDayCode(d) + "," + scheduleRelayCode(d) + "," +
            type + "," + p3OnOff(d.enable, "enable");
        if (type === 2) {
            t += "," + durationSeconds(d.onTime, "onTime") + "," + durationSeconds(d.offTime, "offTime");
        } else if (type === 3) {
            var cond = named(d.condition, "condition", NAMES_CONDITION, 0, 2);
            var watch = named(d.rs485Field, "rs485Field", NAMES_INPUT, 1, 104);
            if (cond === 2) {
                var mn = requireHundredths(d.min, "min"), mx = requireHundredths(d.max, "max");
                if (mn > mx) { throw new Error("min cannot be above max"); }
                t += "," + hundredthsText(mn) + ",2," + watch + "," + hundredthsText(mx);
            } else {
                var th = d.threshold !== undefined ? requireHundredths(d.threshold, "threshold") :
                    requireInt(d.sensorValue, "threshold", -21474836, 21474836) * 100;
                t += "," + hundredthsText(th) + "," + cond + "," + watch;
            }
        } else if (type === 4 && (d.sequences !== undefined || d.steps !== undefined)) {
            // V5.4: delay cyclic with its steps in one downlink: two AT commands with ";"
            t += ";" + P3_SET["schedule steps"](d);
        }
        return t;
    },
    "schedule steps": function (d) {
        // V5.4: as the Maya app, "sequences" 1-9, each with its relays and ON time;
        // sequence 9 is the hold ("relays":"none": all relays OFF for its time)
        var seq = d.sequences !== undefined ? d.sequences : d.steps;
        if (!Array.isArray(seq) || seq.length < 1 || seq.length > 9) {
            throw new Error("sequences: 1 to 9, like {\"sequence\":1,\"relays\":[3,4],\"time\":\"10 min\"}");
        }
        var mask = [0, 0, 0, 0, 0, 0, 0, 0, 0], on = [0, 0, 0, 0, 0, 0, 0, 0, 0], used = [], last = -1;
        seq.forEach(function (st, k) {
            var pos = st.sequence !== undefined ? requireInt(st.sequence, "sequence", 1, 9) - 1 : k;
            if (used[pos]) { throw new Error("sequence " + (pos + 1) + " given twice"); }
            used[pos] = true;
            var none = st.relays === undefined || /^(none|off)$/i.test(String(st.relays));
            var list = none ? [] : Array.isArray(st.relays) ? st.relays : [st.relays];
            list.forEach(function (r) { mask[pos] |= 1 << (requireInt(r, "relays", 1, 8) - 1); });
            on[pos] = durationSeconds(st.time, "time");
            last = Math.max(last, pos);
        });
        var t = "AT+ALMSEQ=" + requireInt(d.slot, "slot", 0, 9);
        for (var n = 0; n <= last; n++) { t += "," + mask[n] + "," + on[n]; }
        return t;
    },
    "schedule enable": function (d) {
        return "AT+SCHED=" + requireInt(d.slot, "slot", 0, 9) + "," + p3OnOff(d.enable, "enable");
    },
    "sampling": function (d) {
        return "AT+SAMPLING=" + (requireInt(d.field, "field", 1, 2) - 1) + "," + requireInt(d.count, "count", 2, 12) +
            "," + p3OnOff(d.enable, "enable") +
            (d.interval !== undefined ? "," + p3Secs(d.interval, "interval", 30, 3600) : "");
    },
    "sampling switch": function (d) { return "AT+SAMPENB=" + p3OnOff(d.enable, "enable"); }
};
var P3_DO = {
    "join again": "AT+JOIN=1", "leave multicast": "AT+MCAST=0", "ping": "AT+UP",
    "delete all schedules": "AT+SCHEDCLR",
    "delete schedule": function (d) { return "AT+ALMDEL=" + requireInt(d.slot, "slot", 0, 9); }
};

function port3Named(data) {
    var verbs = [["read", P3_READ], ["set", P3_SET], ["do", P3_DO]];
    for (var i = 0; i < verbs.length; i++) {
        var what = data[verbs[i][0]];
        if (what === undefined) { continue; }
        var key = String(what).trim().toLowerCase().replace(/\s+/g, " ");
        var entry = verbs[i][1][key];
        if (entry === undefined) {
            throw new Error(verbs[i][0] + ": one of " + Object.keys(verbs[i][1]).join(", "));
        }
        return typeof entry === "function" ? entry(data) : entry;
    }
    throw new Error("port 3: \"read\", \"set\" or \"do\" (or an AT command in \"at\")");
}

// A real value with up to 2 decimals, returned x 100 as a whole number
// (25.5 -> 2550, -5 -> -500), as the LX1 codec (trigger limits).
function requireHundredths(value, name) {
    var v = Number(value);
    if (value === undefined || value === null || value === "" || isNaN(v) ||
        v < -21474836.48 || v > 21474836.47) {
        throw new Error(name + " must be a number from -21474836.48 to 21474836.47");
    }
    var h = Math.round(v * 100);
    if (Math.abs(h - v * 100) > 1e-6 * Math.max(1, Math.abs(v * 100))) {
        throw new Error(name + " can have at most 2 decimals");
    }
    return h;
}

// x 100 -> the shortest text with up to 2 decimals (2550 -> "25.5"), as the board prints it
function hundredthsText(h) {
    var neg = h < 0, a = Math.abs(h), whole = Math.floor(a / 100), cents = a % 100;
    var t = String(whole);
    if (cents !== 0) {
        t += "." + (cents < 10 ? "0" + cents : (cents % 10 === 0 ? String(cents / 10) : String(cents)));
    }
    return (neg ? "-" : "") + t;
}

function pick(a, b) {
    return a !== undefined ? a : b;
}

// V5.4: simple names (the old names still work): "count", "register", "coil", "field",
// "enable", "name", "registerType", "type", "threshold", "input".
var SIMPLE_NAMES = {"8": {"count": "numberofreg", "coil": "address"}, "9": {"count": "numberofreg", "register": "address"}, "10": {"field": "Field", "enable": "Enable", "name": "parameterName", "registerType": "functionCode", "count": "numberOfParameters", "register": "Registeraddress"}, "13": {"registerType": "functionCode", "count": "numberOfParameters", "register": "Registeraddress"}, "11": {"type": "alarmType", "input": "rs485Field"}};
var SIMPLE_NAMES_P3 = {
    // V5.4: the LX1 names on port 3 too (index of a schedule, Field of a Modbus field)
    "field": { "enable": "Enable", "registerType": "functionCode", "count": "numberOfParameters",
        "register": "Registeraddress", "Field": "field" },
    "field name": { "Field": "field" }, "field status": { "Field": "field" }, "field check": { "Field": "field" },
    "registers": { "registerType": "functionCode", "register": "Registeraddress" },
    "find slaves": { "registerType": "functionCode", "register": "Registeraddress" },
    "schedule": { "type": "alarmType", "input": "rs485Field", "index": "slot" },
    "schedule steps": { "index": "slot" }, "schedule enable": { "index": "slot" },
    "delete schedule": { "index": "slot" }
};

function simpleNames(data) {
    var port = Number(data.fPort !== undefined ? data.fPort : data.port);
    var map = SIMPLE_NAMES[String(port)];
    if (port === 3) {
        var what = String(data.set !== undefined ? data.set : data.read !== undefined ? data.read :
            data["do"] !== undefined ? data["do"] : "").toLowerCase();
        map = SIMPLE_NAMES_P3[what];
    }
    if (!map) { return data; }
    var out = {}, k;
    for (k in data) {
        if (data.hasOwnProperty(k)) { out[k] = data[k]; }
    }
    for (k in map) {
        if (out[k] !== undefined && out[map[k]] === undefined) {
            out[map[k]] = out[k];
            delete out[k];
        }
    }
    return out;
}

function encodeDownlink(input) {
    var data = simpleNames(input.data || {}); // V5.4: simple names
    var port = Number(pick(data.fPort, data.port));
    var bytes = [];

    switch (port) {
        case 2: // V5.2, MacSet boards: {"fPort":2,"cmd":"relay","relay":1,"state":1,"seconds":600}
            return { fPort: 2, bytes: encodeMacSetCommand(data) };

        case 3: // V5.2, any AT command: {"fPort":3,"at":"AT+TXTIME=300"}
            // V5.4: words in the AT command ("AT+TXTIME=5 min") become the board's numbers
            var atText = typeof data.at === "string" ? friendlyAt(data.at) : port3Named(data);
            // the board takes up to 159 characters (several commands with ";"); a multicast
            // group (DR2) carries at most 51
            if (typeof atText !== "string" || atText.length === 0 || atText.length > 159) {
                throw new Error("at must be an AT command of 1 to 159 characters");
            }
            for (var c = 0; c < atText.length; c++) {
                bytes.push(atText.charCodeAt(c) & 0x7F);
            }
            break;

        case 5: // relay control: 0 off, 1 on, a relay not given is kept
        case 7:
            // V5.3: relay3 ... relay8 (LX2 board) send all 8 relays; with
            // relay1 / relay2 only the 2-byte command of the other boards
            var count = 2;
            for (var r = 3; r <= 8; r++) {
                if (data["relay" + r] !== undefined) {
                    count = 8;
                }
            }
            for (var k = 1; k <= count; k++) {
                bytes.push(data["relay" + k] === undefined ? 0x03 :
                    requireInt(data["relay" + k], "relay" + k, 0, 255));
            }
            break;

        case 6: // uplink interval: 2 bytes up to 65535 s (every firmware),
                // 4 bytes above, up to 86400 s (firmware from 14 Oct 2026)
            var txTime = requireInt(data.txTime, "txTime", 10, 86400);
            if (txTime > 65535) {
                pushUint32(bytes, txTime);
            } else {
                pushUint16(bytes, txTime);
            }
            break;

        case 9: // Modbus register write
            // V5.4, LX2 V1.0.7: one value per register: {"values":[500,600,700]}, up to 16
            if (Array.isArray(data.values)) {
                if (data.values.length < 1 || data.values.length > 16) {
                    throw new Error("values: 1 to 16 register values");
                }
                if (data.numberofreg !== undefined && Number(data.numberofreg) !== data.values.length) {
                    throw new Error("numberofreg (" + data.numberofreg + ") must equal the number of values (" +
                        data.values.length + ")");
                }
                bytes.push(requireInt(data.slaveId, "slaveId", 1, 247), data.values.length);
                pushUint16(bytes, requireInt(data.address, "address", 0, 65535));
                for (var vi = 0; vi < data.values.length; vi++) {
                    pushUint16(bytes, requireInt(data.values[vi], "values[" + vi + "]", -32768, 65535) & 0xFFFF);
                }
                break;
            }
            // no values list: one register only (value). Several registers: "values".
            if (Number(data.numberofreg) !== 1) {
                throw new Error("port 9: numberofreg 1 with value, or several registers with values:[...]");
            }
            bytes.push(requireInt(data.slaveId, "slaveId", 1, 247), 1);
            pushUint16(bytes, requireInt(data.address, "address", 0, 65535));
            pushUint16(bytes, requireInt(data.value, "value", -32768, 65535) & 0xFFFF);
            break;

        case 8: // Modbus coil write
            // V5.4: one state per coil, {"values":[1,0,1]} (0 OFF, 1 ON), up to 16 coils;
            // one coil also as "value". The bit form (one number for several coils) was removed.
            var coils;
            if (Array.isArray(data.values)) {
                coils = data.values;
            } else if (data.numberofreg === undefined || Number(data.numberofreg) === 1) {
                coils = [Number(data.value) === 65280 ? 1 : data.value]; // LX1 sends ON as 65280 (FF00)
            } else {
                throw new Error("port 8: several coils with values:[1,0,1,...] (one 0/1 per coil)");
            }
            if (coils.length < 1 || coils.length > 16) {
                throw new Error("values: 1 to 16 coil states");
            }
            if (data.numberofreg !== undefined && Number(data.numberofreg) !== coils.length) {
                throw new Error("numberofreg (" + data.numberofreg + ") must equal the number of values (" +
                    coils.length + ")");
            }
            var coilBits = 0;
            for (var ci = 0; ci < coils.length; ci++) {
                if (requireInt(coils[ci], "values[" + ci + "]", 0, 1)) {
                    coilBits |= (1 << ci);
                }
            }
            bytes.push(requireInt(data.slaveId, "slaveId", 1, 247), coils.length);
            pushUint16(bytes, requireInt(data.address, "address", 0, 65535));
            if (coils.length === 1) {
                pushUint16(bytes, coilBits);
            } else {
                pushUint32(bytes, coilBits);
            }
            break;

        case 10: // store a Modbus field
            bytes.push(
                requireInt(data.Field, "Field", 1, 20),
                requireInt(data.slaveId, "slaveId", 0, 255),
                named(data.functionCode, "functionCode", NAMES_FUNCTION, 0, 255),
                requireInt(data.Enable, "Enable", 0, 1),
                named(data.dataType, "dataType", NAMES_DATATYPE, 0, 7),
                requireInt(data.numberOfParameters, "numberOfParameters", 0, 31));
            pushUint16(bytes, requireInt(data.Registeraddress, "Registeraddress", 0, 65535));
            // V5.4, LX2 V1.0.8: the field's name (Maya "Parameter Name") behind, 1-15 characters
            if (data.parameterName !== undefined && String(data.parameterName) !== "") {
                var pn = String(data.parameterName);
                if (pn.length > 15 || !/^[ -+\--<>-~]+$/.test(pn)) {
                    throw new Error("parameterName: 1 to 15 characters, no comma or =");
                }
                for (var pi = 0; pi < pn.length; pi++) {
                    bytes.push(pn.charCodeAt(pi));
                }
            }
            break;

        case 11: // store an alarm
            var alarmType = named(data.alarmType, "alarmType", NAMES_SCHEDULE, 1, 4); // V5.4: 4 Delay cyclic (LX2)
            bytes.push(requireInt(pick(data.slot, data.index), "slot", 0, 9));
            pushUint32(bytes, clockSeconds(data.startTime, "startTime"));
            pushUint32(bytes, clockSeconds(data.stopTime, "stopTime"));
            bytes.push(
                scheduleDayCode(data), // V5.4: "days":"all" or ["Mon","Fri"] (or the old dayData)
                scheduleRelayCode(data), // V5.4: "relays":3 or "relays":[3,4] (or the old relayStatus)
                alarmType,
                requireInt(data.enable, "enable", 0, 1));
            if (alarmType === 2) { // cyclic
                var onSeconds = durationSeconds(data.onTime, "onTime");
                var offSeconds = durationSeconds(data.offTime, "offTime");
                pushUint32(bytes, onSeconds);
                pushUint32(bytes, offSeconds);
                if (onSeconds + offSeconds === 0) {
                    throw new Error("onTime and offTime cannot both be 0");
                }
            } else if (alarmType === 3) { // trigger
                var condition = named(pick(data.condition, data.level), "condition", NAMES_CONDITION, 0, 2);
                var trigField = named(data.rs485Field, "rs485Field", NAMES_INPUT, 1, 255);
                if (data.threshold !== undefined || data.min !== undefined || data.max !== undefined) {
                    // as LX1 (LX2 firmware 1.0.0): x 100 with sign, between with Min and Max (23 bytes)
                    var low, high = 0;
                    if (condition === 2) {
                        low = requireHundredths(data.min, "min");
                        high = requireHundredths(data.max, "max");
                        if (low > high) {
                            throw new Error("min cannot be above max");
                        }
                    } else {
                        low = requireHundredths(data.threshold, "threshold");
                    }
                    pushUint32(bytes, low);
                    bytes.push(condition, trigField);
                    pushUint32(bytes, high);
                } else {
                    // older format (19 bytes): whole-number threshold
                    pushUint32(bytes, requireInt(data.sensorValue, "sensorValue", -2147483648, 4294967295));
                    bytes.push(condition, trigField);
                }
            }
            break;

        case 12: // RS485 baud rate and parity
            // The controller takes the baud rate as 16 bits, so 115200
            // cannot be set with this downlink (use AT+BAUD).
            pushUint16(bytes, requireInt(data.baud, "baud", 1200, 65535));
            bytes.push(named(pick(data.pairity, data.parity), "parity", NAMES_PARITY, 0, 2));
            break;

        case 13: // read a register now
            bytes.push(
                requireInt(data.slaveId, "slaveId", 0, 255),
                named(data.functionCode, "functionCode", NAMES_FUNCTION, 0, 255),
                named(data.dataType, "dataType", NAMES_DATATYPE, 0, 7),
                requireInt(data.numberOfParameters, "numberOfParameters", 1, 31));
            pushUint16(bytes, requireInt(data.Registeraddress, "Registeraddress", 0, 65535));
            break;

        case 14: // read an alarm back
            bytes.push(requireInt(pick(data.slot, data.index), "slot", 0, 9));
            break;

        case 15: // read a Modbus field back: {"fPort":15,"field_read":1} (V5.4; "Field" and "index" still accepted)
            bytes.push(requireInt(pick(pick(data.field_read, data.Field), pick(data.field, data.index)), "field_read", 1, 20));
            break;

        case 17: // V5.4: ADR, as LX1 (LX2 firmware 1.0.0)
            bytes.push(named(data.adr, "adr", { "off": 0, "on": 1 }, 0, 1));
            break;

        case 18: // V5.4: message type, as LX1: 1 confirmed, 0 unconfirmed
            bytes.push(named(data.msgtype, "msgtype", { "unconfirmed": 0, "confirmed": 1 }, 0, 1));
            break;

        case 19: // V5.4: ADR, SF and message type, as LX1
            bytes.push(
                named(data.adr, "adr", { "off": 0, "on": 1 }, 0, 1),
                requireInt(data.sf, "sf", 7, 12),
                named(data.msgtype, "msgtype", { "unconfirmed": 0, "confirmed": 1 }, 0, 1));
            break;

        case 21: // V5.4: sampling settings (LX2 V1.0.1, as LX1), the bytes of the LBS-STD-X1 node
            bytes.push(
                data.field !== undefined ? requireInt(data.field, "field", 1, 2) - 1 :
                    requireInt(data.param, "field", 0, 1),
                requireInt(data.count, "count", 2, 12),
                requireInt(data.enable, "enable", 0, 1));
            if (data.interval !== undefined) {
                pushUint16(bytes, requireInt(data.interval, "interval", 30, 3600));
            }
            break;

        default:
            throw new Error("fPort " + pick(data.fPort, data.port) +
                " is not a controller command port (5 to 15, 21)");
    }
    return {
        fPort: port,
        bytes: bytes
    };
}

// V5.2: MacSet FPort 2 commands (V5.3: relays 1-8 and inputs 1-4 for LX2)
//   relay     relay 1-8, state 0/1, seconds (optional, switch back after)
//   relays    relay1 ... relay8: 0/1; relays not given are kept
//   interval  seconds 10..65535
//   inputs    input1 ... input4: "4-20mA" or "0-10V" (not given: 0-10V)
//   mode      "rs485" or "analog" (sensor type; LX1: what the J2 terminals are used for)
//   status    send a data frame now
//   reboot    restart the controller
function encodeMacSetCommand(data) {
    switch (data.cmd) {
        case "relay":
            var cmd = [0x02, requireInt(data.relay, "relay", 1, 8), requireInt(data.state, "state", 0, 1)];
            if (data.seconds !== undefined) {
                pushUint16(cmd, requireInt(data.seconds, "seconds", 1, 65535));
            }
            return cmd;
        case "relays": // [01][mask: relays to set][states]
            var mask = 0;
            var states = 0;
            for (var r = 1; r <= 8; r++) {
                if (data["relay" + r] !== undefined) {
                    mask |= 1 << (r - 1);
                    states |= requireInt(data["relay" + r], "relay" + r, 0, 1) << (r - 1);
                }
            }
            if (mask === 0) {
                throw new Error("relays needs at least one of relay1 ... relay8");
            }
            return [0x01, mask, states];
        case "interval":
            var interval = [0x03];
            pushUint16(interval, requireInt(data.seconds, "seconds", 10, 65535));
            return interval;
        case "inputs": // V5.4, LX2 V1.0.4: [0C][kind A1..A4], 0 disable, 1 4-20mA, 2 0-10V, 3 digital, FF keep
            var KINDS = { "disable": 0, "off": 0, "4-20ma": 1, "0-10v": 2, "digital": 3 };
            var kinds = [0x0C];
            var any = false;
            for (var c = 1; c <= 4; c++) {
                var k = data["input" + c];
                if (k === undefined) {
                    kinds.push(0xFF);           // not given: kept
                    continue;
                }
                var v = KINDS[String(k).toLowerCase().replace(/\s/g, "")];
                if (v === undefined) {
                    throw new Error("input" + c + " must be 4-20mA, 0-10V, digital or disable");
                }
                kinds.push(v);
                any = true;
            }
            if (!any) {
                throw new Error("inputs needs at least one of input1 ... input4");
            }
            return kinds;
        case "mode":
            if (data.mode !== "rs485" && data.mode !== "analog") {
                throw new Error("mode must be rs485 or analog");
            }
            return [0x07, data.mode === "analog" ? 1 : 0];
        case "status":
            return [0x05];
        case "reboot":
            return [0x06];
        case "multicast": // join: address and both session keys of the ChirpStack group
            var mc = [0x08];
            pushHexBytes(mc, data.mcAddr, 4, "mcAddr");
            pushHexBytes(mc, data.mcNwkSKey, 16, "mcNwkSKey");
            pushHexBytes(mc, data.mcAppSKey, 16, "mcAppSKey");
            if (mc[1] === 0 && mc[2] === 0 && mc[3] === 0 && mc[4] === 0) {
                throw new Error("mcAddr 00000000 is no group: use cmd multicastLeave");
            }
            return mc;
        case "multicastLeave":
            return [0x09];
        case "motor": // V5.4, LX2 V1.0.3: [0B][motor 1-4][state]; the board refuses it unless that relay pair is a motor (Three phase)
            return [0x0B, requireInt(data.motor, "motor", 1, 4), requireInt(data.state, "state", 0, 1)];
        case "motors": // V5.4, LX2 V1.0.5: start (1) / stop (0) several motors at once: [0D][which][states]
            var which = 0;
            var run = 0;
            for (var mo = 1; mo <= 4; mo++) {
                if (data["motor" + mo] !== undefined) {
                    which |= 1 << (mo - 1);
                    run |= requireInt(data["motor" + mo], "motor" + mo, 0, 1) << (mo - 1);
                }
            }
            if (which === 0) {
                throw new Error("motors needs at least one of motor1 ... motor4");
            }
            return [0x0D, which, run];
        case "application": // V5.4, LX2: Single phase (8 relays) or Three phase (4 motors), nothing mixed
            if (data.phase !== "single" && data.phase !== "three") {
                throw new Error("phase must be single or three");
            }
            return [0x0A, 0x0F, data.phase === "three" ? 0x0F : 0x00];
        default:
            throw new Error("cmd must be relay, relays, interval, inputs, mode, status, reboot, multicast, multicastLeave, motor, motors or application");
    }
}

/*
 * Changes from V5.0
 *  1. Decode() for the Milesight gateway passed the byte array where an
 *     object was expected and failed on every uplink.
 *  2. decodeUplink() read input.port, which does not exist: uplinkPort was
 *     always empty. It is input.fPort.
 *  3. Undeclared variables: byteIndex and fieldIndex are errors only where
 *     a codec runs in strict mode (the user's ChirpStack ran V5.0 fine);
 *     numberofreg and fieldNames made the port 9 response and the MacSense
 *     trigger and sample frames fail everywhere.
 *  4. Controller boot frame: the controller sends the hardware version
 *     first and the firmware version second; FR and HW were swapped.
 *     TDCM is the uplink interval in seconds, not milliseconds.
 *  5. Controller periodic frame: deviceinfo.battery was the relay 2 byte
 *     divided by 10. Controllers have no battery; the key is left out.
 *  6. Modbus write response: the value is taken as 2 or 4 bytes from the
 *     frame length. With more than one register V5.0 read 4 bytes while
 *     the controller sends 2, which also broke the time stamp.
 *  7. Port 13 response: the time stamp was read from the data bytes.
 *  8. Analog alarm frame, level set point: wrote into an object that did
 *     not exist.
 *  9. Time stamps are read unsigned.
 * 10. Encoder: port 7 added; values are checked against the ranges the
 *     firmware accepts; an unknown port raises an error instead of an
 *     empty downlink; "parity" and "level" are accepted as well as
 *     "pairity" and "condition".
 * 11. getSensorData() no longer cuts the caller's byte array.
 * 12. Boot frame: FR and HW are plain numbers, "1.0.0", as in the SHT40
 *     codec. V5.0 wrote each byte as two hex digits, "01.00.00".
 * 13. Port 6 (14 Oct 2026): txTime up to 86400 s. Above 65535 s the
 *     encoder sends 4 bytes and the response carries 4 bytes; up to
 *     65535 s nothing changes, so older firmware still works.
 * 14. Relay event uplink on FPort 4 (15 Oct 2026): decoded as relayEvent
 *     (relay states, what changed, cause, schedule slot and type).
 * 15. Relay event reasons (19 Oct 2026): a 36-byte event adds
 *     relay1Reason / relay2Reason for each relay that changed, and for a
 *     trigger schedule relay1Trigger / relay2Trigger (field, condition,
 *     value, threshold). A relay that went OFF names the schedule that
 *     held it ON. 14-byte events from older firmware decode as before.
  *
 * Changes in V5.2 (MacSet LX1)
 * 16. FPort 3 uplink: the answer to an AT command, decoded as atReply (text).
 * 17. Encoder: FPort 3 {"at": "AT+..."} sends an AT command; FPort 2
 *     {"cmd": ...} sends the MacSet commands. Ports 5..15 are unchanged.
 * 18. Port 6 (28 Oct 2026): txTime from 10 s (was 30 s); the LX1 firmware
 *     of 28 Oct 2026 accepts it, older firmware refuses below 30 s.
 * 19. FPort 2 (29 Oct 2026): cmd "multicast" (mcAddr, mcNwkSKey, mcAppSKey in
 *     hex) puts the board into a multicast group in one downlink (37 bytes),
 *     cmd "multicastLeave" takes it out; cmd "interval" from 10 s.
 *
 * Changes in V5.3 (MacSet-L LX2, MS-L3-CT-X2: 8 relays, 4 analog inputs)
 * 20. Periodic frames of the LX2 board carry relays 3-8 in 3 bytes
 *     [D7][C0 | relays 3-7][C0 | relay 8] in front of the controller block:
 *     decoded as controller.r3Status ... r8Status. Frames without the block
 *     (LX1, MacSet-LPC, nodes) decode as in V5.2. V5.2 itself reads LX2
 *     frames correctly but without relays 3-8 (in an RS485 frame it shows
 *     the 3 bytes as 3 more "Disabled" fields).
 * 21. Port 5 response: relay3 ... relay8 when the board sends them.
 * 22. Encoder ports 5 / 7: relay3 ... relay8 send the 8-byte command (LX2
 *     firmware from 3 Nov 2026); with relay1 / relay2 only, the 2-byte
 *     command as before.
 * 23. FPort 2: cmd "relay" relay 1-8, cmd "relays" relay1 ... relay8 (only
 *     the relays given change; V5.2 always set relays 1 and 2), cmd "inputs"
 *     input1 ... input4. cmd "mode" works on LX2 too (firmware from 3 Nov 2026).
 * 24. Device type 4 (LX2 firmware from 3 Nov 2026): one periodic frame with
 *     the 4 analog inputs (analogData channel_a ... channel_d: disabled,
 *     current mA, voltage V or digital level) and the Modbus fields
 *     (field1 ... field20) and relays 1-8. The boot frame carries type 4 as
 *     well. V5.2 does not know type 4 and decodes nothing for it.
 * 25. Motor starters 2-4 (LX2 firmware from 3 Nov 2026): the LX2 board drives up
 *     to 4 three phase motors, motor n on relays 2n-1 (START) / 2n (STOP), each
 *     enabled on its own (AT+MOTORS, port 2 cmd "motors"). controller.motors
 *     lists them ("1,3" or "none"); motor<n>Status replaces the two relays of a
 *     motor pair (motor 1 stays "status" with appType "Three Phase", as before).
 *     Encoder: cmd "motor" (motor 1-4, state) and cmd "motors" (motor1..motor4).
 *
 * Changes in V5.4 (MacSet-L LX2 firmware V1.0.1, 20 Nov 2026)
 * 26. Schedules (port 11 store, port 14 read back): relayStatus 0 relay 1,
 *     1 relay 2, 2 both as before, any other value a bit mask of relays 1-8
 *     (bit 0 = relay 1; 12 = relays 3 + 4; a motor through its START relay).
 *     The answer adds relays ("3,4") and scheduleType.
 * 27. Schedule type 4 "delay cyclic": stored on port 11 like a regular one
 *     (no extra bytes); its up to 9 steps are set with an AT command on
 *     FPort 3: {"fPort":3,"at":"AT+ALMSEQ=<slot>,<mask 1>,<s 1>,...,<mask 9>,<s 9>"}
 *     (step 9: mask 0 = hold, all relays OFF).
 * 28. Trigger schedules: rs485Field 101-104 = analog input A1-A4 (LX2);
 *     the answer adds triggerSource ("field5", "analog input A2").
 * 30. Sampling (LX2 firmware V1.0.1, as LX1; copied from the LX1 codec):
 *     FPort 3 readings decoded as sampling (source, input, type, samples,
 *     time stamp), the FPort 21 echo as samplingConfig. Encoder FPort 21:
 *     {"fPort":21,"param":0,"count":5,"enable":1,"interval":60}.
 *     AT answers on FPort 3 decode as before.
 * 53. As LX1 (LX2 firmware 1.0.0): trigger threshold with 2 decimals ("threshold":25.5, sent
 *     x 100, 23 bytes), condition 2 "between" with "min" / "max"; the port 11 answer and the
 *     relay event give them back; ports 17 adr, 18 msgtype, 19 adr + sf + msgtype, answered
 *     on the same port (lorawanConfig). The old whole-number "sensorValue" still works.
 * 52. LX1 names (MacnMan_LoRaWAN_Decoders, MS_L5_CT_X1): "port", index, dayData, relayStatus,
 *     alarmType, threshold, condition, rs485Field, Field, Enable, functionCode, numberOfParameters,
 *     Registeraddress, numberofreg, address, param; port 15 index. dayData and relayStatus also
 *     take "all" / day names and a list of relays. The port 10 and 11 answers use the LX1 names.
 * 51. Delay cyclic as the Maya app: "sequences":[{"sequence":1,"relays":[2],"time":"10 min"},
 *     {"sequence":9,"relays":"none","time":"5 min"}] (9 = the hold, all OFF); "steps" still works.
 * 50. Port 3 "set":"schedule" with type "delay cyclic" takes its "steps" too
 *     ([{"relays":[2],"time":"10 min"},{"relays":"none","time":"5 min"}]): sent as
 *     AT+ALMENB...;AT+ALMSEQ... in one downlink. Port 3 text up to 159 characters (multicast: 51).
 * 49. Simple names (old names still work): ports 8/9 count, coil / register; port 10 field, enable,
 *     name, registerType, count, register; port 13 registerType, count, register; port 11 type,
 *     threshold, input. The port 10 and port 11 answers use the same names.
 * 48. Port 3 with named values instead of AT text: {"fPort":3,"read":"heartbeat"},
 *     {"fPort":3,"set":"heartbeat","time":"5 min"}, {"fPort":3,"do":"delete schedule","slot":3}.
 *     "set":"schedule" takes the keys of port 11. The "at" text still works.
 * 47. Port 3: words in the AT commands (on/off, "5 min", "holding registers", "Mon-Fri",
 *     "relays 3+4", "cyclic", "2026-11-21 15:30" ...) become the numbers the board reads;
 *     numbers are passed on unchanged. The 51-character limit counts the numbers sent.
 * 46. Words instead of code numbers (the numbers still work): functionCode "holding registers",
 *     dataType "uint16", alarmType "cyclic", condition "less than", rs485Field "A1" (or a
 *     field 1-20), parity "even"; port 21 "field" 1 or 2 instead of param 0 or 1.
 * 45. Port 11: startTime / stopTime as a clock time "06:00" (00:00-24:00), onTime / offTime
 *     as "10 min", "30 s", "2 h" or "1 h 30 min"; the answer shows them the same way.
 *     The old seconds are still accepted.
 * 44. Port 11: "days" replaces "dayData": "all" (every day) or a list of day names,
 *     e.g. ["Mon","Tue","Wed","Thu","Fri"] or ["Sun"]; the answer shows them the same way.
 *     The old "dayData" number is still accepted.
 * 43. Port 11: "relays" replaces "relayStatus": one relay = its number ("relays":3 or [3]),
 *     several = a list ("relays":[3,4]); the answer shows them the same way.
 *     The old "relayStatus" number is still accepted.
 * 42. Ports 11 and 14: the schedule slot is "slot" (0-9; "index" still accepted); the port 11
 *     answer shows it as "slot".
 * 41. Port 8 coils: {"values":[1,0,1,0,0,1,0,1]}, one 0/1 per coil from address on, up to 16
 *     (numberofreg, if given, must match). The bit form ("value":165 for 8 coils) was removed.
 *     The answer shows several coils as values [..] too.
 * 40. Port 10 answer (field stored, or read back with {"fPort":15,"Field":n}) readable:
 *     Field, Enable on/off, parameterName (LX2 firmware with field names sends it), slaveId, functionCode
 *     "3 holding registers", dataType "uint16", numberOfParameters, Registeraddress and
 *     addressInMaya (+1). Port 15 takes "field_read" ("Field" and "index" still accepted).
 * 39. Port 10 (LX2 firmware V1.0.8): "parameterName" (1-15 characters, no comma) is sent
 *     behind the field settings; the board stores it as the field's name (AT+MODLABEL) and
 *     the Maya app shows it. Older firmware refuses a port 10 downlink with a name.
 * 38. Port 9 (LX2 firmware V1.0.7): {"values":[500,600,700]} writes one value per register,
 *     up to 16, from address on (function 16); the answer shows them as values.
 *     Without values: one register only (numberofreg 1, value); the 32-bit form
 *     (numberofreg 2 with one value) was removed: use values:[high, low].
 * 37. FPort 2 cmd "motors" (LX2 firmware V1.0.5): start / stop several motors in one
 *     downlink, {"cmd":"motors","motor1":1,"motor2":1,"motor3":0,"motor4":1}: [0D][which][states];
 *     motors not given are kept. Three phase only: refused if a motor given is not a motor.
 * 36. FPort 2 cmd "application" replaces cmd "motors": {"cmd":"application","phase":"single"}
 *     (8 relays) or "three" (4 motors). The LX2 board (V1.0.4) refuses a mixed set-up,
 *     as the Maya app has only these two.
 * 35. FPort 2 cmd "inputs" (LX2 firmware V1.0.4): [0C][A1][A2][A3][A4], each "4-20mA",
 *     "0-10V", "digital" or "disable"; an input not given is kept (FF). Before: [04][mask],
 *     4-20mA or 0-10V only, an input not given became 0-10V. Firmware before V1.0.4 does
 *     not know 0C.
 * 34. FPort 2 cmd "motor" (LX2 firmware V1.0.3): its own command [0B][motor][state]
 *     instead of the relay command [02][START relay][state]: the board starts / stops a
 *     motor only while that relay pair is a motor (Three phase), and refuses cmd "relay" /
 *     "relays" for a relay of a motor. Firmware before V1.0.3 does not know 0B.
 * 33. LX2 analog inputs (device type 4): current rounded to 0.1 mA, as the
 *     Maya app shows it (18 uA with nothing connected: 0 mA), voltage to 0.01 V.
 *     The LX1 / analog controller frames (type 3) are not rounded.
 * 32. Lists in number order (ChirpStack shows a map's keys in a random order):
 *     fieldList, motorList, relayList and channelList next to the keys,
 *     e.g. fieldList ["field1: 12.5", "field2: Disabled", ...].
 * 31. Three phase (LX2): controller.motor1Status as motor2Status ... motor4Status;
 *     controller.status (motor 1) stays for the older dashboards.
 * 29. Relay event (port 4): the 38-byte LX2 event adds relays and
 *     changedRelays ("1,4,7") and relay3 ... relay8 (0/1). 14- and 36-byte
 *     events decode as before.
 */
