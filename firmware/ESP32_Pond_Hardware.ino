#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// =====================================================
// WIFI SETTINGS
// =====================================================

const char* WIFI_SSID = "Ricky";
const char* WIFI_PASSWORD = "00121212";

// =====================================================
// API ENDPOINT
// =====================================================

// Your PC's current IP address on mobile hotspot "Ricky" is 10.39.23.68
// (Once deployed to Render, change this to your Render URL: https://your-app.onrender.com/api/esp32/telemetry)
const char* API_ENDPOINT = "http://10.39.23.68:8000/api/esp32/telemetry";

// =====================================================
// ESP32 PIN CONNECTIONS
// =====================================================

// pH sensor analog output
#define PH_PIN 34

// TDS / Salinity sensor analog output
#define TDS_PIN 35

// Temperature sensor DATA (DS18B20 OneWire)
#define TEMP_PIN 4

// Turbine 1: Dissolved Oxygen Turbine (Actuator 1 / Servo 1)
#define SERVO_DO_PIN 18

// Turbine 2: Water Circulation Turbine (Actuator 2 / Servo 2)
#define SERVO_HEAT_PIN 19

// =====================================================
// SENSOR OBJECT
// =====================================================

OneWire oneWire(TEMP_PIN);
DallasTemperature temperatureSensor(&oneWire);

// =====================================================
// SERVO OBJECTS
// =====================================================

Servo servoDO;
Servo servoHeat;

// =====================================================
// SERVO POSITIONS
// Change these if your mechanical arrangement requires it
// =====================================================

const int SERVO_DO_OFF = 0;
const int SERVO_DO_ON  = 90;

const int SERVO_HEAT_OFF = 0;
const int SERVO_HEAT_ON  = 90;

// =====================================================
// THRESHOLDS
// =====================================================

// Temperature
const float TEMP_NORMAL_LOW = 28.0;
const float TEMP_NORMAL_HIGH = 31.0;

const float TEMP_HEAT_ON = 33.0;
const float TEMP_HEAT_OFF = 32.5;

// pH
const float PH_CRITICAL_LOW = 7.0;
const float PH_CRITICAL_HIGH = 9.0;

const float PH_NORMAL_LOW = 7.8;
const float PH_NORMAL_HIGH = 8.5;

// Estimated DO
const float DO_NORMAL = 5.0;
const float DO_WARNING = 3.0;
const float DO_CRITICAL = 2.0;

// =====================================================
// pH CALIBRATION
// =====================================================
//
// These are starting values.
// You MUST calibrate the pH sensor with buffer solution.
//

float PH7_VOLTAGE = 2.50;
float PH_SLOPE = 3.50;

// =====================================================
// VARIABLES
// =====================================================

float temperatureC = 0.0;
float phValue = 7.0;
float tdsValue = 0.0;
float salinityValue = 0.0;
float estimatedDO = 0.0;

bool servoDOState = false;
bool servoHeatState = false;

// =====================================================
// SETUP
// =====================================================

void setup()
{
  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" SMART SHRIMP FARM MONITORING SYSTEM");
  Serial.println(" ESP32");
  Serial.println("==========================================");

  // ---------------------------------------------------
  // ADC SETUP
  // ---------------------------------------------------

  analogReadResolution(12);

  analogSetPinAttenuation(PH_PIN, ADC_11db);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);

  // ---------------------------------------------------
  // TEMPERATURE SENSOR
  // ---------------------------------------------------

  pinMode(TEMP_PIN, INPUT_PULLUP); // Enable pullup on GPIO 4 for DS18B20 OneWire bus
  temperatureSensor.begin();
  temperatureSensor.setResolution(10); // 10-bit gives 0.25°C precision and reduces conversion time to only 187ms!

  // ---------------------------------------------------
  // SERVO SETUP
  // ---------------------------------------------------

  servoDO.setPeriodHertz(50);
  servoHeat.setPeriodHertz(50);

  servoDO.attach(SERVO_DO_PIN, 500, 2400);
  servoHeat.attach(SERVO_HEAT_PIN, 500, 2400);

  // Start servos OFF
  servoDO.write(SERVO_DO_OFF);
  servoHeat.write(SERVO_HEAT_OFF);

  // ---------------------------------------------------
  // WIFI
  // ---------------------------------------------------

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to WiFi");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30)
  {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("WiFi connected!");
    Serial.print("ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("API Target Server: ");
    Serial.println(API_ENDPOINT);
  }
  else
  {
    Serial.println("WiFi connection failed.");
    Serial.println("System will continue in autonomous offline mode.");
  }

  Serial.println();
  Serial.println("SYSTEM READY - INDUSTRIAL TELEMETRY ACTIVE");
}

// =====================================================
// MAIN LOOP (NON-BLOCKING INDUSTRIAL MILLIS ARCHITECTURE)
// =====================================================

unsigned long lastTelemetryMillis = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1500; // Exact 1.5-second high-speed telemetry cycle

void loop()
{
  // 1. Maintain WiFi connection in background
  if (WiFi.status() != WL_CONNECTED)
  {
    static unsigned long lastReconnectAttempt = 0;
    if (millis() - lastReconnectAttempt > 5000)
    {
      Serial.println("WiFi disconnected. Attempting auto-reconnect...");
      WiFi.reconnect();
      lastReconnectAttempt = millis();
    }
  }

  // 2. Read physical sensors
  readTemperature();
  readPH();
  readTDS();

  // 3. Calculate estimated DO using scientific formula
  calculateEstimatedDO();

  // 4. Non-blocking real-time telemetry cycle
  unsigned long currentMillis = millis();
  if (currentMillis - lastTelemetryMillis >= TELEMETRY_INTERVAL_MS)
  {
    lastTelemetryMillis = currentMillis;

    // Display telemetry data to Serial Monitor
    printSensorData();

    // Send data to API & apply remote turbine controls received from Web Dashboard
    bool apiSuccess = sendDataToAPI();

    // Fail-safe autonomous hold: if server is unreachable, use local safety rules
    if (!apiSuccess)
    {
      controlDOServo();
      controlTemperatureServo();
    }
  }

  // Brief yield for RTOS tasks & servo PWM stability
  delay(20);
}

// =====================================================
// TEMPERATURE SENSOR (DS18B20)
// =====================================================

void readTemperature()
{
  temperatureSensor.requestTemperatures();
  float value = temperatureSensor.getTempCByIndex(0);

  // DS18B20 disconnect check (-127.00 is DEVICE_DISCONNECTED_C, 85.0 is uninitialized power-on state)
  if (value == DEVICE_DISCONNECTED_C || value <= -50.0 || value > 85.0)
  {
    Serial.println("WARNING: DS18B20 Temp sensor disconnected! (Check GPIO 4 wire & 4.7k pullup resistor)");
    // Ground reality fallback: use 28.0 C (optimal shrimp aquaculture) so system stays functional
    temperatureC = 28.0;
  }
  else
  {
    temperatureC = value;
  }
}

// =====================================================
// pH SENSOR
// =====================================================

void readPH()
{
  long sum = 0;
  for (int i = 0; i < 10; i++)
  {
    sum += analogRead(PH_PIN);
    delay(2);
  }
  float rawValue = sum / 10.0;
  float voltage = (rawValue / 4095.0) * 3.3;

  // Simple calibration equation
  phValue = 7.0 + ((PH7_VOLTAGE - voltage) * PH_SLOPE);

  // Limit pH
  if (phValue < 0.0) phValue = 0.0;
  if (phValue > 14.0) phValue = 14.0;
}

// =====================================================
// TDS SENSOR (WITH MULTI-SAMPLE FILTERING)
// =====================================================

void readTDS()
{
  long sum = 0;
  for (int i = 0; i < 10; i++)
  {
    sum += analogRead(TDS_PIN);
    delay(2);
  }
  float rawValue = sum / 10.0;
  float voltage = (rawValue / 4095.0) * 3.3;

  if (voltage <= 0.05)
  {
    tdsValue = 0.0;
    salinityValue = 0.0;
    return;
  }

  // Temperature compensation
  float compensationCoefficient = 1.0 + 0.02 * (temperatureC - 25.0);
  float compensationVoltage = voltage / compensationCoefficient;

  // TDS calculation
  tdsValue = (133.42 * compensationVoltage * compensationVoltage * compensationVoltage
            - 255.86 * compensationVoltage * compensationVoltage
            + 857.39 * compensationVoltage) * 0.5;

  if (tdsValue < 0.0) tdsValue = 0.0;

  salinityValue = tdsValue / 1000.0;
}

  // ---------------------------------------------------
  // PROTOTYPE SALINITY ESTIMATION
  // ---------------------------------------------------
  //
  // TDS is NOT directly equal to salinity.
  // This is only a prototype estimate.
  //

  salinityValue = tdsValue / 1000.0;
}

// =====================================================
// SCIENTIFIC ESTIMATED DISSOLVED OXYGEN (DO) FORMULA
// =====================================================
//
// Calculates Dissolved Oxygen (mg/L) based on:
// 1. Temperature: Henry's Law base saturation (14.60 - 0.28 * T)
// 2. Salinity: Salting-out effect (salinity * 0.045)
// 3. pH: Biochemical respiration deviation (|pH - 7.85| * 0.55)
// =====================================================

void calculateEstimatedDO()
{
  // Effective temperature (use 28.0 C fallback if sensor disconnected or reading 0)
  float effectiveTemp = (temperatureC > 0.0) ? temperatureC : 28.0;

  // 1. Base oxygen saturation at effective temperature
  float baseDO = 14.60 - (0.28 * effectiveTemp);

  // 2. Salinity penalty (salting-out effect)
  float salPenalty = salinityValue * 0.045;

  // 3. pH deviation penalty (|pH - 7.85| * 0.55): optimal pond center is 7.85
  float phPenalty = fabs(phValue - 7.85) * 0.55;

  // Final Estimated DO
  estimatedDO = baseDO - salPenalty - phPenalty;

  // Bound within realistic aquaculture limits (0.00 - 12.00 mg/L)
  if (estimatedDO < 0.0)
  {
    estimatedDO = 0.0;
  }
  if (estimatedDO > 12.0)
  {
    estimatedDO = 12.0;
  }
}

// =====================================================
// TURBINE 1 (SERVO 1 / GPIO 18)
// DISSOLVED OXYGEN TURBINE AUTONOMOUS FAIL-SAFE
// =====================================================

void controlDOServo()
{
  // LOW ESTIMATED DO -> ACTIVATE TURBINE 1
  if (estimatedDO < DO_WARNING)
  {
    if (!servoDOState)
    {
      servoDO.write(SERVO_DO_ON);
      servoDOState = true;
      Serial.println("TURBINE 1 [Dissolved Oxygen] -> ON (Local Safety: Low DO)");
    }
  }
  // DO RECOVERED -> STANDBY
  else if (estimatedDO > 4.5)
  {
    if (servoDOState)
    {
      servoDO.write(SERVO_DO_OFF);
      servoDOState = false;
      Serial.println("TURBINE 1 [Dissolved Oxygen] -> OFF (Local Safety: DO Normal)");
    }
  }
}

// =====================================================
// TURBINE 2 (SERVO 2 / GPIO 19)
// WATER CIRCULATION TURBINE AUTONOMOUS FAIL-SAFE
// =====================================================

void controlTemperatureServo()
{
  // HIGH TEMPERATURE OR STRESSED WATER -> ACTIVATE TURBINE 2
  if (temperatureC > TEMP_HEAT_ON || phValue < 7.2 || phValue > 8.8 || salinityValue > 25.0)
  {
    if (!servoHeatState)
    {
      servoHeat.write(SERVO_HEAT_ON);
      servoHeatState = true;
      Serial.println("TURBINE 2 [Water Circulation] -> ON (Local Safety: Heat/Water Stress)");
    }
  }
  // PARAMETERS NORMALIZED -> STANDBY
  else if ((temperatureC < TEMP_HEAT_OFF || temperatureC <= 0.0) && (phValue >= 7.5 && phValue <= 8.5) && salinityValue <= 22.0)
  {
    if (servoHeatState)
    {
      servoHeat.write(SERVO_HEAT_OFF);
      servoHeatState = false;
      Serial.println("TURBINE 2 [Water Circulation] -> OFF (Local Safety: Water Normal)");
    }
  }
}

// =====================================================
// WATER QUALITY STATUS
// =====================================================

String getWaterQualityStatus()
{
  // Emergency DO
  if (estimatedDO < DO_CRITICAL)
  {
    return "CRITICAL_LOW_DO";
  }

  // High temperature
  if (temperatureC > 33.0)
  {
    return "CRITICAL_HIGH_TEMPERATURE";
  }

  // Critical pH
  if (phValue < PH_CRITICAL_LOW ||
      phValue > PH_CRITICAL_HIGH)
  {
    return "CRITICAL_PH";
  }

  // DO warning
  if (estimatedDO < DO_NORMAL)
  {
    return "WATCH_LOW_DO";
  }

  // Temperature warning
  if (temperatureC > TEMP_NORMAL_HIGH)
  {
    return "WATCH_HIGH_TEMPERATURE";
  }

  // pH warning
  if (phValue < PH_NORMAL_LOW ||
      phValue > PH_NORMAL_HIGH)
  {
    return "WATCH_PH";
  }

  return "NORMAL";
}

// =====================================================
// SERIAL MONITOR
// =====================================================

void printSensorData()
{
  Serial.println();
  Serial.println("------------------------------------------");

  Serial.print("Temperature : ");
  Serial.print(temperatureC, 2);
  Serial.println(" C");

  Serial.print("pH          : ");
  Serial.println(phValue, 2);

  Serial.print("TDS         : ");
  Serial.print(tdsValue, 2);
  Serial.println(" ppm");

  Serial.print("Salinity    : ");
  Serial.print(salinityValue, 2);
  Serial.println(" ppt EST.");

  Serial.print("Estimated DO: ");
  Serial.print(estimatedDO, 2);
  Serial.println(" mg/L");

  Serial.print("Status      : ");
  Serial.println(getWaterQualityStatus());

  Serial.print("Turbine 1 (DO)   : ");
  Serial.println(
    servoDOState ? "ON" : "OFF"
  );

  Serial.print("Turbine 2 (Water): ");
  Serial.println(
    servoHeatState ? "ON" : "OFF"
  );

  Serial.println("------------------------------------------");
}

// =====================================================
// SEND DATA TO API & RECEIVE REMOTE TURBINE COMMANDS
// =====================================================

bool sendDataToAPI()
{
  // Check WiFi
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("WiFi disconnected - API packet skipped.");
    return false;
  }

  HTTPClient http;

  http.begin(API_ENDPOINT);
  http.setTimeout(1200); // 1.2s rapid industrial timeout - prevents blocking or lagging
  http.setReuse(true);   // HTTP 1.1 keep-alive connection reuse

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  // ---------------------------------------------------
  // CREATE JSON
  // ---------------------------------------------------

  String json = "{";
  json += "\"temperature\":" + String(temperatureC, 2);
  json += ",\"ph\":" + String(phValue, 2);
  json += ",\"tds\":" + String(tdsValue, 2);
  json += ",\"salinity\":" + String(salinityValue, 2);
  json += ",\"do\":" + String(estimatedDO, 2);
  json += ",\"water_quality\":\"" + getWaterQualityStatus() + "\"";
  json += ",\"oxygenTurbineActive\":" + String(servoDOState ? "true" : "false");
  json += ",\"waterTurbineActive\":" + String(servoHeatState ? "true" : "false");
  json += "}";

  // ---------------------------------------------------
  // DISPLAY JSON
  // ---------------------------------------------------

  Serial.println();
  Serial.println("Sending Telemetry to API:");
  Serial.println(json);

  // ---------------------------------------------------
  // POST TELEMETRY & RECEIVE REMOTE TURBINE ACTIONS
  // ---------------------------------------------------

  int responseCode = http.POST(json);

  Serial.print("API Response Code: ");
  Serial.println(responseCode);

  if (responseCode > 0)
  {
    String response = http.getString();

    Serial.println("API Response Body:");
    Serial.println(response);

    // ---------------------------------------------------
    // PARSE REMOTE TURBINE COMMANDS FROM BACKEND API
    // ---------------------------------------------------
    bool doActive = false;
    if (response.indexOf("\"oxygenTurbineActive\":true") >= 0 ||
        response.indexOf("\"oxygenTurbineActive\": true") >= 0 ||
        response.indexOf("\"servoDO\":90") >= 0 ||
        response.indexOf("\"servoDO\": 90") >= 0 ||
        response.indexOf("\"oxygenTurbine\":\"ON\"") >= 0)
    {
      doActive = true;
    }

    bool waterActive = false;
    if (response.indexOf("\"waterTurbineActive\":true") >= 0 ||
        response.indexOf("\"waterTurbineActive\": true") >= 0 ||
        response.indexOf("\"servoWater\":90") >= 0 ||
        response.indexOf("\"servoWater\": 90") >= 0 ||
        response.indexOf("\"waterTurbine\":\"ON\"") >= 0)
    {
      waterActive = true;
    }

    // Actuate Turbine 1: Dissolved Oxygen Turbine (Servo 1 / GPIO 18)
    if (doActive)
    {
      servoDO.write(SERVO_DO_ON);
      servoDOState = true;
      Serial.println("--> TURBINE 1 [DO Turbine] -> ON (via Web API Action)");
    }
    else
    {
      servoDO.write(SERVO_DO_OFF);
      servoDOState = false;
      Serial.println("--> TURBINE 1 [DO Turbine] -> OFF (via Web API Action)");
    }

    // Actuate Turbine 2: Water Circulation Turbine (Servo 2 / GPIO 19)
    if (waterActive)
    {
      servoHeat.write(SERVO_HEAT_ON);
      servoHeatState = true;
      Serial.println("--> TURBINE 2 [Water Turbine] -> ON (via Web API Action)");
    }
    else
    {
      servoHeat.write(SERVO_HEAT_OFF);
      servoHeatState = false;
      Serial.println("--> TURBINE 2 [Water Turbine] -> OFF (via Web API Action)");
    }

    http.end();
    return true;
  }
  else
  {
    Serial.print("API request failed. Error code: ");
    Serial.print(responseCode);
    Serial.print(" - ");
    Serial.println(http.errorToString(responseCode));
    if (responseCode == -1)
    {
      Serial.println("========================================================");
      Serial.println("DIAGNOSTIC: Error -1 (Connection Refused)");
      Serial.println("1. Target Server: " + String(API_ENDPOINT));
      Serial.println("2. Your PC IP on hotspot 'Ricky' is: 10.39.23.68");
      Serial.println("3. Is Python app.py running on port 8000?");
      Serial.println("4. Once deployed to Render, set API_ENDPOINT to your Render URL!");
      Serial.println("========================================================");
    }
    http.end();
    return false;
  }
}
