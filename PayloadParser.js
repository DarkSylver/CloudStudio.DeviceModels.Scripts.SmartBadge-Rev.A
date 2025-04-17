//03:01:04:01:00:02:00:01:02:01:01 port 18

function parseUplink(device, payload) {
    var payloadb = payload.asBytes();
    var decoded = Decoder(payloadb, payload.port);
    env.log(decoded);

    // Store battery
    if (decoded.battery != null) {
        var sensor1 = device.endpoints.byAddress("1");
        if (sensor1 != null) {
            sensor1.updateVoltageSensorStatus(decoded.battery);
        }
    }

    // Store temperature
    if (decoded.temperature != null) {
        var sensor2 = device.endpoints.byAddress("2");
        if (sensor2 != null) {
            sensor2.updateTemperatureSensorStatus(decoded.temperature);
        }
    }

   // Store position data if available
    if (decoded.latitude != null && decoded.longitude != null) {
        var sensor3 = device.endpoints.byAddress("3");
        if (sensor3 != null) {
            sensor3.updateLocationTrackerStatus(decoded.latitude, decoded.longitude);
        }
    }

    // Store status if available
    if (decoded.status != null) {
        var sensorStatus = device.endpoints.byAddress("4");
        if (sensorStatus != null) {
            // Verificar que decoded.status.mode sea un número entero
            var statusMode = parseInt(decoded.status.mode, 10);
            if (!isNaN(statusMode)) {
                sensorStatus.updateIASSensorStatus(statusMode);
            } else {
                env.log("Error: decoded.status.mode no es un número válido.");
            }
        }
    }
}


function Decoder(bytes, port) {
    function step_size(lo, hi, nbits, nresv) {
        return 1.0 / ((((1 << nbits) - 1) - nresv) / (hi - lo));
    }

    function mt_value_decode(value, lo, hi, nbits, nresv) {
        return (value - nresv / 2) * step_size(lo, hi, nbits, nresv) + lo;
    }

    function bits(value, lsb, msb) {
        var len = msb - lsb + 1;
        var mask = (1 << len) - 1;
        return value >> lsb & mask;
    }

    function bit(value, bit) {
        return (value & (1 << bit)) > 0;
    }

    function hex(bytes, separator) {
        return bytes.map(function (b) {
            return ("0" + b.toString(16)).substr(-2);
        }).join(separator || "");
    }

    function int32(bytes) {
        return bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3];
    }

    function uint32(bytes) {
        return (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
    }

    function mac_rssi(bytes) {
        var items = [];
        for (var offset = 0; offset < bytes.length; offset += 7) {
            items.push({
                mac_address: hex(bytes.slice(offset, offset + 6), ":"),
                rssi: bytes[offset + 6] << 24 >> 24,
            });
        }
        return items;
    }

    function message(code, descriptions) {
        return {
            code: code,
            description: code < 0 || code >= descriptions.length ? "UNKNOWN" : descriptions[code]
        };
    }

    var decoded = {};
    var i;

    var type = bytes[0];

    if (type !== 0x00) {
        decoded.status = {
            mode: message(bits(bytes[1], 5, 7), ["Standby", "Motion tracking", "Permanent tracking",
                "Motion start/end tracking", "Activity tracking", "OFF"]),
            sos: bit(bytes[1], 4),
            tracking: bit(bytes[1], 3),
            moving: bit(bytes[1], 2),
            periodic: bit(bytes[1], 1),
            on_demand: bit(bytes[1], 0)
        };

        decoded.battery = bytes[2] / 100;
        decoded.temperature = Math.round(100 * mt_value_decode(bytes[3], -44, 85, 8, 0)) / 100;
        decoded.ack = bits(bytes[4], 4, 7);
        decoded.data = bits(bytes[4], 0, 3);
        decoded.lastResetCause = "lastResetCause: " + bytes[5];
        decoded.mcuFirmware = "fwVersion: " + bytes[6] + "." + bytes[7] + "." + bytes[8];
        decoded.bleFirmware = "bleFwVersion: " + bytes[9] + "." + bytes[10] + "." + bytes[11];
    }

    switch (type) {
        case 0x00:
            decoded.type = "FRAME PENDING";
            decoded.token = bytes[1];
            break;

        case 0x03:
            decoded.type = "POSITION";
            switch (decoded.data) {
                case 0:
                    decoded.position_type = "GPS fix";
                    decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
                    decoded.latitude = (bytes[6] << 24 | bytes[7] << 16 | bytes[8] << 8) / 1e7;
                    decoded.longitude = (bytes[9] << 24 | bytes[10] << 16 | bytes[11] << 8) / 1e7;
                    decoded.ehpe = mt_value_decode(bytes[12], 0, 1000, 8, 0);
                    break;

                case 1:
                    decoded.position_type = "GPS timeout";
                    decoded.timeout_cause = message(bytes[5], ["User timeout cause"]);
                    for (i = 0; i < 4; i++) {
                        decoded["cn" + i] = mt_value_decode(bytes[6 + i], 0, 2040, 8, 0);
                    }
                    break;

                case 2:
                    decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
                    break;

                case 3:
                    decoded.position_type = "WIFI timeout";
                    for (i = 0; i < 6; i++) {
                        decoded["v_bat" + (i + 1)] = mt_value_decode(bytes[5 + i], 2.8, 4.2, 8, 2);
                    }
                    break;

                case 4:
                    decoded.position_type = "WIFI failure";
                    for (i = 0; i < 6; i++) {
                        decoded["v_bat" + (i + 1)] = mt_value_decode(bytes[5 + i], 2.8, 4.2, 8, 2);
                    }
                    decoded.error = message(bytes[11], ["WIFI connection failure", "Scan failure",
                        "Antenna unavailable", "WIFI not supported on this device"]);
                    break;

                case 5:
                case 6:
                    decoded.position_type = "LP-GPS data";
                    decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
                    break;

                case 7:
                    decoded.position_type = "BLE beacon scan";
                    decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
                    decoded.beacons = mac_rssi(bytes.slice(6));
                    break;

                case 8:
                    decoded.position_type = "BLE beacon failure";
                    decoded.error = message(bytes[5], ["BLE is not responding", "Internal error", "Shared antenna not available",
                        "Scan already on going", "No beacon detected", "Hardware incompatibility"]);
                    break;

                case 9:
                    decoded.position_type = "WIFI BSSIDs";
                    decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
                    decoded.stations = mac_rssi(bytes.slice(6));
                    break;

                default:
                    decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
            }
            break;

        case 0x04:
            decoded.type = "ENERGY STATUS";
            break;

        case 0x05:
            decoded.type = "WORK TIME";
            decoded.age = mt_value_decode(bytes[1], 0, 60, 8, 0);
            decoded.runcounter = mt_value_decode(bytes.slice(2, 4), 0, 120, 16, 0);
            decoded.shutdowntimer = mt_value_decode(bytes.slice(4, 6), 0, 60, 16, 0);
            break;

        case 0x06:
            decoded.type = "VIBRATION";
            decoded.age = mt_value_decode(bytes[1], 0, 2040, 8, 0);
            decoded.vibration = mt_value_decode(bytes.slice(2, 4), 0, 300, 16, 0);
            decoded.acceleration = mt_value_decode(bytes.slice(4, 6), 0, 60, 16, 0);
            break;

        default:
            decoded.error = message(0, ["UNSUPPORTED TYPE " + type]);
    }

    return decoded;
}
