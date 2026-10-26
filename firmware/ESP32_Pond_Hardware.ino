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

// Your computer's current Wi-Fi IP address (or replace with Render URL when deployed)
const char* API_ENDPOINT = "http://192.168.29.30:8000/api/esp32/telemetry";

// =====================================================
// ESP32 PIN CONNECTIONS
// =====================================================

// pH sensor analog output
#define PH_PIN 34

// TDS / Salinity sensor analog output
#define TDS_PIN 35

// Temperature sensor DATA
#define TEMP_PIN 4

// Servo 1 = DO / Oxygen
#define SERVO_DO_PIN 18

// Servo 2 = High Temperature
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

  temperatureSensor.begin();

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

    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  }
  else
  {
    Serial.println("WiFi connection failed.");

    Serial.println("System will continue without WiFi.");
  }

  Serial.println();
  Serial.println("SYSTEM READY");
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop()
{
  // Read all sensors
  readTemperature();

  readPH();

  readTDS();

  // Calculate estimated DO
  calculateEstimatedDO();

  // Control Servo 1
  controlDOServo();

  // Control Servo 2
  controlTemperatureServo();

  // Display values
  printSensorData();

  // Send data to API
  sendDataToAPI();

  // Wait 5 seconds
  delay(5000);
}

// =====================================================
// TEMPERATURE
// =====================================================

void readTemperature()
{
  temperatureSensor.requestTemperatures();

  float value = temperatureSensor.getTempCByIndex(0);

  if (value == DEVICE_DISCONNECTED_C)
  {
    Serial.println("ERROR: Temperature sensor disconnected!");

    temperatureC = 0;
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
  int rawValue = analogRead(PH_PIN);

  float voltage =
      (rawValue / 4095.0) * 3.3;

  // Simple calibration equation
  phValue =
      7.0 + ((PH7_VOLTAGE - voltage) * PH_SLOPE);

  // Limit pH
  if (phValue < 0)
  {
    phValue = 0;
  }

  if (phValue > 14)
  {
    phValue = 14;
  }
}

// =====================================================
// TDS SENSOR
// =====================================================

void readTDS()
{
  int rawValue = analogRead(TDS_PIN);

  float voltage =
      (rawValue / 4095.0) * 3.3;

  if (voltage <= 0)
  {
    tdsValue = 0;

    salinityValue = 0;

    return;
  }

  // Temperature compensation
  float compensationCoefficient =
      1.0 + 0.02 * (temperatureC - 25.0);

  float compensationVoltage =
      voltage / compensationCoefficient;

  // TDS calculation
  tdsValue =
      (133.42 *
       compensationVoltage *
       compensationVoltage *
       compensationVoltage
       -
       255.86 *
       compensationVoltage *
       compensationVoltage
       +
       857.39 *
       compensationVoltage)
      * 0.5;

  if (tdsValue < 0)
  {
    tdsValue = 0;
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
// ESTIMATED DO
// =====================================================
//
// There is NO physical DO sensor.
//
// This value is estimated using:
// - Temperature
// - pH
// - Salinity
//
// It is NOT actual measured dissolved oxygen.
// =====================================================

void calculateEstimatedDO()
{
  // Start with nominal DO
  estimatedDO = 8.0;

  // ---------------------------------------------------
  // TEMPERATURE EFFECT
  // ---------------------------------------------------

  if (temperatureC > 31.0)
  {
    estimatedDO =
        estimatedDO -
        ((temperatureC - 31.0) * 0.30);
  }

  // ---------------------------------------------------
  // SALINITY EFFECT
  // ---------------------------------------------------

  if (salinityValue > 20.0)
  {
    estimatedDO =
        estimatedDO -
        ((salinityValue - 20.0) * 0.03);
  }

  // ---------------------------------------------------
  // pH EFFECT
  // ---------------------------------------------------

  if (phValue < 7.5 || phValue > 8.8)
  {
    estimatedDO =
        estimatedDO - 0.5;
  }

  // Limit
  if (estimatedDO < 0)
  {
    estimatedDO = 0;
  }

  if (estimatedDO > 10)
  {
    estimatedDO = 10;
  }
}

// =====================================================
// SERVO 1
// DO / OXYGEN ACTION
// =====================================================

void controlDOServo()
{
  // LOW ESTIMATED DO
  if (estimatedDO < DO_WARNING)
  {
    if (!servoDOState)
    {
      servoDO.write(SERVO_DO_ON);

      servoDOState = true;

      Serial.println(
        "SERVO 1 -> ON (LOW DO)"
      );
    }
  }

  // DO RECOVERED
  else if (estimatedDO > 3.5)
  {
    if (servoDOState)
    {
      servoDO.write(SERVO_DO_OFF);

      servoDOState = false;

      Serial.println(
        "SERVO 1 -> OFF (DO RECOVERED)"
      );
    }
  }
}

// =====================================================
// SERVO 2
// HIGH TEMPERATURE ACTION
// =====================================================

void controlTemperatureServo()
{
  // HIGH TEMPERATURE
  if (temperatureC > TEMP_HEAT_ON)
  {
    if (!servoHeatState)
    {
      servoHeat.write(SERVO_HEAT_ON);

      servoHeatState = true;

      Serial.println(
        "SERVO 2 -> ON (HIGH TEMPERATURE)"
      );
    }
  }

  // TEMPERATURE RECOVERED
  else if (temperatureC < TEMP_HEAT_OFF)
  {
    if (servoHeatState)
    {
      servoHeat.write(SERVO_HEAT_OFF);

      servoHeatState = false;

      Serial.println(
        "SERVO 2 -> OFF (TEMPERATURE NORMAL)"
      );
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

  Serial.print("Servo 1 DO  : ");
  Serial.println(
    servoDOState ? "ON" : "OFF"
  );

  Serial.print("Servo 2 Heat: ");
  Serial.println(
    servoHeatState ? "ON" : "OFF"
  );

  Serial.println("------------------------------------------");
}

// =====================================================
// SEND DATA TO API
// =====================================================

void sendDataToAPI()
{
  // Check WiFi
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println(
      "WiFi disconnected - API not sent"
    );

    return;
  }

  HTTPClient http;

  http.begin(API_ENDPOINT);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  // ---------------------------------------------------
  // CREATE JSON
  // ---------------------------------------------------

  String json = "{";

  json += "\"temperature\":";
  json += String(temperatureC, 2);

  json += ",\"ph\":";
  json += String(phValue, 2);

  json += ",\"tds\":";
  json += String(tdsValue, 2);

  json += ",\"salinity\":";
  json += String(salinityValue, 2);

  // CHANGED "estimated_do" to "do" so that app.py recognizes the oxygen parameter!
  json += ",\"do\":";
  json += String(estimatedDO, 2);

  json += ",\"water_quality\":\"";
  json += getWaterQualityStatus();
  json += "\"";

  json += ",\"servo_do\":";
  json +=
    servoDOState ? "true" : "false";

  json += ",\"servo_heat\":";
  json +=
    servoHeatState ? "true" : "false";

  json += "}";

  // ---------------------------------------------------
  // DISPLAY JSON
  // ---------------------------------------------------

  Serial.println();
  Serial.println("Sending JSON:");
  Serial.println(json);

  // ---------------------------------------------------
  // POST
  // ---------------------------------------------------

  int responseCode =
      http.POST(json);

  Serial.print(
    "API Response Code: "
  );

  Serial.println(responseCode);

  if (responseCode > 0)
  {
    String response =
        http.getString();

    Serial.println(
      "API Response:"
    );

    Serial.println(response);
  }
  else
  {
    Serial.print("API request failed. Error code: ");
    Serial.print(responseCode);
    Serial.print(" - ");
    Serial.println(http.errorToString(responseCode));
    Serial.println("Checklist: 1. Is Python app.py running? 2. Is IP 192.168.29.30 correct? 3. Is ESP32 and PC on same Wi-Fi 'Ricky'?");
  }

  http.end();
}
