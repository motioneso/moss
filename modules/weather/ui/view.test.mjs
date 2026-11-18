import assert from "node:assert/strict";
import test from "node:test";
import {
  locationHint,
  unitDescription,
  savedMessage,
  positionFailure,
  readBrowserPosition,
  forecastPresentation,
  conditionIcon,
  intervalLabel
} from "./view.mjs";

test("the hint names the place and how it was chosen", () => {
  const place = { label: "San Diego, California, United States" };
  assert.equal(locationHint(place), "Using San Diego, California, United States.");
  assert.match(locationHint(place, "auto"), /found with Use my location/);
  assert.match(locationHint(place, "search"), /set by searching/);
  assert.match(locationHint(null), /main city of your time zone/);
});

test("the unit text says Fahrenheit or Celsius", () => {
  assert.equal(unitDescription("imperial"), "Temperatures are shown in Fahrenheit.");
  assert.equal(unitDescription("metric"), "Temperatures are shown in Celsius.");
});

test("saved messages cover a place and a reset", () => {
  assert.equal(savedMessage({ label: "Paris" }), "Weather location saved: Paris.");
  assert.match(savedMessage(null), /automatic detection/);
});

test("a blocked position and other failures read differently", () => {
  assert.match(positionFailure({ code: 1 }), /blocked/);
  assert.match(positionFailure({ code: 2 }), /couldn't be found/);
});

test("position reads refuse without sharing support or a secure address", async () => {
  await assert.rejects(readBrowserPosition({}), /can't share your location/);
  await assert.rejects(
    readBrowserPosition({ navigator: { geolocation: {} }, isSecureContext: false }),
    /https/
  );
  const got = await readBrowserPosition({
    navigator: {
      geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 1, longitude: 2 } }) }
    },
    isSecureContext: true
  });
  assert.equal(got.coords.latitude, 1);
});

const forecast = {
  timeZone: "America/Los_Angeles",
  localDate: "2026-11-17",
  startHour: 18,
  endHour: 21,
  requestedStart: "2026-11-18T02:00:00.000Z",
  requestedEnd: "2026-11-18T05:00:00.000Z",
  retrievedAt: "2026-11-17T23:00:00.000Z",
  intervals: [
    { startsAt: "2026-11-18T02:00:00.000Z", temperature: 60.4, condition: "Clear" },
    { startsAt: "2026-11-18T03:00:00.000Z", temperature: 58.6, condition: "Clear" }
  ]
};

test("the card shows each hour of the window and marks a missing one", () => {
  const p = forecastPresentation(forecast);
  assert.equal(p.hours.length, 3);
  assert.equal(p.hours[2].temperature, null);
  assert.equal(p.min, 59);
  assert.equal(p.max, 60);
  assert.equal(p.condition, "Clear");
  assert.equal(p.day, "This evening");
});

test("labels and icons follow the local hour", () => {
  assert.equal(
    intervalLabel(
      Date.parse("2026-11-18T02:00:00Z"),
      Date.parse("2026-11-18T03:00:00Z"),
      "America/Los_Angeles"
    ),
    "6–7 PM"
  );
  assert.equal(
    conditionIcon("Clear", Date.parse("2026-11-18T02:00:00Z"), "America/Los_Angeles"),
    "moon"
  );
  assert.equal(
    conditionIcon("Clear", Date.parse("2026-11-17T20:00:00Z"), "America/Los_Angeles"),
    "sun"
  );
  assert.equal(conditionIcon("Light rain", Date.now(), "UTC"), "cloud-rain");
  assert.equal(conditionIcon("???", Date.now(), "UTC"), "circle-help");
});
