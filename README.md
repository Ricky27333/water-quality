# 🦐 Smart Shrimp Farming System Using IoT – Water Quality Monitoring & Oxygen Turbine Automation

A full-stack, real-time aquaculture automation system designed for commercial shrimp ponds (*Penaeus vannamei* / Black Tiger shrimp). The system connects an **ESP8266 microcontroller** measuring **4 core water quality sensors** to an intelligent FastAPI backend and modern single-page dashboard, featuring **automated Oxygen Turbine control** and a **hardware offline watchdog fail-safe** that automatically zeroes out metrics (`000`) when telemetry disconnects.

---

## 🌟 Key Project Highlights

1. **4 Core Physical Sensors Interfacing**:
   - **Dissolved Oxygen (DO) Probe**: `0.0 – 12.0 mg/L` (Interfaced via ADS1115 16-bit ADC Channel A0).
   - **Analog pH Probe**: `0.0 – 14.0 pH` (Interfaced via ADS1115 16-bit ADC Channel A1).
   - **Salinity / Electrical Conductivity Probe**: `0.0 – 40.0 ppt` (Interfaced via ADS1115 16-bit ADC Channel A2).
   - **Water Temperature Sensor**: `-10.0 – 50.0 °C` (Waterproof DS18B20 digital 1-Wire probe on Pin D4 / GPIO 2).

2. **Oxygen Turbine Automation Engine**:
   - **Automatic Activation**: Engages Oxygen Turbine relay (`Pin D5 / GPIO 14`) immediately when **Dissolved Oxygen < 4.0 mg/L** or when water temperature rises above **31.0 °C** with DO < 4.5 mg/L.
   - **Hysteresis Prevention**: Keeps turbine running until DO safely recovers to **≥ 5.5 mg/L**, preventing destructive relay motor chatter.
   - **Tri-Mode Controls**: `AUTO` (intelligent algorithm), `MANUAL ON` (forced run), and `MANUAL OFF` (maintenance/feeding stop).

3. **Hardware Offline Watchdog & "000" Fail-Safe**:
   - The backend tracks real-time heartbeat pings from the ESP8266.
   - If no telemetry arrives within **20 seconds** (power failure, Wi-Fi loss, or probe disconnect):
     - All 4 dashboard sensor readouts immediately display **`000`** (e.g. `000 mg/L`, `000 pH`, `000 ppt`, `000 °C`).
     - Badges switch from `NORMAL` to **`SYSTEM OFFLINE`** (pulsing red alert).
     - Oxygen Turbines default to **`OFFLINE (SAFE HOLD)`**.
     - A prominent warning banner alerts farm operators.
     - As soon as the ESP8266 powers on and reconnects, live metrics automatically restore!

4. **Interactive Digital Twin & Analytics**:
   - Physics-based digital twin with animated water waves, swimming shrimp canvas simulation, and active aerator/turbine animations.
   - Interactive historical charts powered by **ApexCharts** with 1-hour, 24-hour, and 7-day filters.
   - Built-in **1-Click Hardware Offline Simulator** for live classroom and viva demonstration.

---

## 📋 Recommended Safe Water Quality Thresholds

| Parameter | Unit | Safe Range | Biological Importance for Shrimp (*P. vannamei*) |
| :--- | :--- | :--- | :--- |
| **Dissolved Oxygen (DO)** | `mg/L` | **4.0 – 8.0** | DO < 3.5 mg/L causes lethal hypoxia; DO < 4.0 mg/L triggers Oxygen Turbines |
| **pH Level** | `pH` | **7.5 – 8.5** | Acidic (< 7.0) softens carapace; alkaline (> 9.0) accelerates toxic unionized ammonia |
| **Salinity** | `ppt` | **10.0 – 25.0** | Vital for osmoregulation, carapace molting, and postlarval survival |
| **Water Temperature** | `°C` | **26.0 – 32.0** | Affects metabolism and feeding; high temp (>32°C) severely depletes dissolved oxygen |

---

## 🔌 ESP8266 Hardware Circuit & Pinout Table

Because the **ESP8266 (NodeMCU)** has only **1 single analog pin (`A0`)**, this project uses an **ADS1115 16-bit I2C ADC module** to sample the 3 analog probes with high precision, plus a digital **DS18B20 probe** on digital pin D4.

```
                  +-----------------------------------+
                  |        ESP8266 NodeMCU            |
                  |                                   |
ADS1115 (SCL) <---| Pin D1 (GPIO 5)                   |
ADS1115 (SDA) <---| Pin D2 (GPIO 4)                   |
DS18B20 Temp  <---| Pin D4 (GPIO 2) [4.7k Pull-up]    |
Relay Turbine --->| Pin D5 (GPIO 14) [Active LOW]     |---> Relay IN1 ---> 220V Oxygen Turbine
Relay Aerator --->| Pin D6 (GPIO 12) [Active LOW]     |---> Relay IN2 ---> 220V Surface Aerator
Status LED    <---| Pin D0 (GPIO 16)                  |
5V Power In   --->| VIN & GND                         |
                  +-----------------------------------+
                                    |
                    +---------------+---------------+
                    | ADS1115 16-bit I2C Converter  |
                    | (Addr: 0x48)                  |
                    | A0: Dissolved Oxygen Probe    |
                    | A1: Analog pH Sensor Probe    |
                    | A2: Analog Salinity (EC) Probe|
                    +-------------------------------+
```

### Complete Pin Connections

| Module / Component | Module Pin | ESP8266 Pin | NodeMCU GPIO | Protocol / Signal |
| :--- | :--- | :--- | :--- | :--- |
| **ADS1115 ADC** | `SCL` | `D1` | `GPIO 5` | I2C Clock Line |
| **ADS1115 ADC** | `SDA` | `D2` | `GPIO 4` | I2C Data Line |
| **ADS1115 ADC** | `VDD` & `GND` | `3V3` & `GND` | Power | 3.3V DC Power |
| **DO Probe** | `AOUT` | `A0` (ADS1115) | — | Analog Voltage (0 – 3.0V) |
| **pH Probe** | `AOUT` | `A1` (ADS1115) | — | Analog Voltage (0 – 3.0V) |
| **Salinity Probe** | `AOUT` | `A2` (ADS1115) | — | Analog Voltage (0 – 3.0V) |
| **DS18B20 Temp** | `DATA` | `D4` | `GPIO 2` | Digital 1-Wire (4.7kΩ pull-up to 3.3V) |
| **Relay Module** | `IN1` (Turbine)| `D5` | `GPIO 14` | Active-LOW Trigger (Oxygen Turbine) |
| **Relay Module** | `IN2` (Aerator)| `D6` | `GPIO 12` | Active-LOW Trigger (Surface Aerator) |

---

## 📡 Dedicated ESP8266 API Reference & Integration

The backend provides high-performance, flexible endpoints specifically created for the **ESP8266**:

| Endpoint | Method | Input Format | Description |
| :--- | :--- | :--- | :--- |
| `/api/esp8266/telemetry` | `POST` | JSON Body | **Primary ESP8266 Telemetry Endpoint**. Receives JSON readings, resets watchdog, and immediately returns the Oxygen Turbine command in the response. |
| `/api/esp8266/update` | `GET` | Query String | **Lightweight HTTP GET Telemetry Endpoint**. For simple sketches without JSON libraries: `?temp=28.5&ph=7.8&sal=18.2&do=6.1`. Returns turbine command. |
| `/api/esp8266/turbine` | `GET` | URL (`?format=plain` or `json`) | Lightweight polling endpoint for the ESP8266 to check if the turbine should run (`ON` / `OFF`). |
| `/api/esp8266/status` | `GET` | — | Returns ESP8266 connection health, heartbeat age, and online/offline boolean. |
| `/api/sensors` | `GET` | — | Returns 4 core sensor values formatted for dashboard. **If hardware is offline, returns `000` with status `SYSTEM OFFLINE`**. |
| `/api/hardware/toggle-offline` | `POST` | — | Manually toggles offline/online state for viva demonstration without unplugging cables. |
| `/api/turbine/control` | `POST` | JSON (`{"mode": "AUTO" \| "ON" \| "OFF"}`) | Operator manual override for the Oxygen Turbine. |
| `/api/pond/history?range=24h` | `GET` | Query String | Historical telemetry points for time-series graphing. |

---

### 📥 1. ESP8266 JSON Telemetry Request Example (`POST /api/esp8266/telemetry`)
```json
{
  "temperature": 28.5,
  "pH": 7.8,
  "salinity": 18.2,
  "dissolvedOxygen": 6.1
}
```
*(Accepts flexible aliases such as `temp`, `ph`, `sal`, `do`)*

### 📤 2. Immediate Server Response to ESP8266
```json
{
  "status": "success",
  "message": "Telemetry received from ESP8266",
  "timestamp": 1727100000000,
  "turbine": "OFF",
  "turbineActive": false,
  "relayLevel": 1,
  "mode": "AUTO",
  "systemStatus": "ONLINE",
  "offlineFailSafe": false
}
```
> **Note**: For standard active-LOW relay modules, `relayLevel: 0` activates the Oxygen Turbine and `relayLevel: 1` deactivates it.

---

### 📥 3. ESP8266 GET Query Telemetry Example (`GET /api/esp8266/update`)
```http
GET /api/esp8266/update?temp=28.5&ph=7.8&sal=18.2&do=6.1 HTTP/1.1
Host: 192.168.1.100:8000
```
*(Ideal for minimal Arduino sketches using simple `http.begin(client, url)`)

---

## 🚀 Running the Server & Web Dashboard

### 1. Prerequisites
- **Python 3.8+** installed.
- Required Python packages:
  ```bash
  pip install fastapi uvicorn requests pydantic
  ```

### 2. Start the FastAPI Server
Open terminal in the project directory:
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Access Dashboard & API Docs
- **Web Dashboard**: `http://localhost:8000`
- **Interactive Swagger API Docs**: `http://localhost:8000/docs`
- **ESP8266 Quick Docs**: `http://localhost:8000/api/esp8266/docs`

---

## 🎓 Semester Viva & Presentation Talking Points

When presenting this project to examiners or professors, be prepared with these core technical answers:

1. **Why use an ADS1115 ADC with ESP8266 instead of reading directly?**
   - *Answer*: The ESP8266 only has 1 single onboard ADC (`A0`) with a 10-bit resolution (0–1.0V). Because shrimp pond management requires measuring 3 analog probes (DO, pH, and Salinity) plus temperature, the ADS1115 provides 4 high-precision 16-bit differential/single-ended channels over I2C, freeing up ESP8266 GPIOs while drastically improving signal-to-noise ratio.

2. **Why automate Oxygen Turbines based on Dissolved Oxygen?**
   - *Answer*: Hypoxia is the leading cause of sudden shrimp mortality in aquaculture. Unlike surface paddlewheels that only agitate the top water, deep venturi Oxygen Turbines inject micro-bubbles directly into the benthic zone where shrimp feed. Automating with hysteresis (turn ON at <4.0 mg/L, turn OFF at ≥5.5 mg/L) ensures adequate biological saturation without cycling the motor repeatedly.

3. **Why does the system display `000` when hardware goes offline?**
   - *Answer*: In industrial IoT, freezing on the last known sensor value when communication drops is dangerous because an operator might assume pond conditions are normal when in fact sensors have failed. The active 20-second watchdog timer immediately zeros out the display to `000` and flags `SYSTEM OFFLINE`, ensuring operators are alerted immediately to investigate power or network issues.
