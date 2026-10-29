// Opens the V5 brain's system serial port. Native Web Serial where it exists
// (desktop Chrome and Edge), WebUSB plus the serial polyfill where it does not
// (Chrome on Android).
import { SerialPort as PolyfillPort } from './vendor/serial-polyfill.js';

export const VEX_VENDOR_ID = 0x2888;
export const BRAIN_PRODUCT_ID = 0x0501;
const FILTER = { usbVendorId: VEX_VENDOR_ID, usbProductId: BRAIN_PRODUCT_ID };
const USB_FILTER = { vendorId: VEX_VENDOR_ID, productId: BRAIN_PRODUCT_ID };

// The brain exposes two CDC-ACM pairs. Pair 0/1 is the system port the upload
// uses; pair 2/3 is the user (terminal) port. The polyfill takes the first
// control interface (class 2) and the first data interface (class 10) it finds,
// which is pair 0/1. assertSystemInterfaces() checks that at run time.
const SYSTEM_CONTROL_IFACE = 0;
const SYSTEM_DATA_IFACE = 1;

const MSG = {
  unsupported: "This browser can't talk to USB devices. Use Chrome on Android, or Chrome or Edge on a computer.",
  nonePicked: 'No brain was picked.',
  busy: 'The brain is in use by another app. Close VEXcode or other VEX tabs, then try again.',
  wrongIface: "Couldn't find the brain's system port. Unplug the brain, plug it back in, and try again.",
  openFailed: "Couldn't open the brain. Unplug it, plug it back in, and try again.",
};

export function support() {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  return { serial: hasNativeSerial(), usb: !!nav.usb };
}

// Chrome on Android has navigator.serial, but it only lists Bluetooth ports,
// so the brain never shows up there. Android goes through WebUSB instead.
function isAndroid() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData) return navigator.userAgentData.platform === 'Android';
  return /Android/i.test(navigator.userAgent || '');
}

function hasNativeSerial() {
  return typeof navigator !== 'undefined' && !!navigator.serial && !isAndroid();
}

function hasUsb() {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

function assertSystemInterfaces(port) {
  const c = port.controlInterface_ && port.controlInterface_.interfaceNumber;
  const d = port.transferInterface_ && port.transferInterface_.interfaceNumber;
  // These fields are private in the polyfill; if a future version renames them
  // we skip the check rather than block a working upload.
  if (c === undefined || d === undefined) return;
  if (c !== SYSTEM_CONTROL_IFACE || d !== SYSTEM_DATA_IFACE) throw new Error(MSG.wrongIface);
}

function wrapUsb(device) {
  const port = new PolyfillPort(device);
  assertSystemInterfaces(port);
  port.__usbDevice = device;
  return port;
}

export async function requestBrain() {
  if (hasNativeSerial()) {
    try {
      return await navigator.serial.requestPort({ filters: [FILTER] });
    } catch (e) {
      if (e && e.name === 'NotFoundError') throw new Error(MSG.nonePicked);
      throw new Error(MSG.openFailed);
    }
  }
  if (hasUsb()) {
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: [USB_FILTER] });
    } catch (e) {
      if (e && e.name === 'NotFoundError') throw new Error(MSG.nonePicked);
      throw new Error(MSG.openFailed);
    }
    try {
      return wrapUsb(device);
    } catch (e) {
      if (e instanceof Error && e.message === MSG.wrongIface) throw e;
      throw new Error(MSG.wrongIface);
    }
  }
  throw new Error(MSG.unsupported);
}

export async function knownBrain() {
  try {
    if (hasNativeSerial()) {
      const ports = await navigator.serial.getPorts();
      return ports.find((p) => {
        const i = p.getInfo ? p.getInfo() : {};
        return i.usbVendorId === VEX_VENDOR_ID && i.usbProductId === BRAIN_PRODUCT_ID;
      }) || null;
    }
    if (hasUsb()) {
      const devices = await navigator.usb.getDevices();
      const d = devices.find((x) => x.vendorId === VEX_VENDOR_ID && x.productId === BRAIN_PRODUCT_ID);
      return d ? wrapUsb(d) : null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

export async function openBrain(port) {
  if (!port) throw new Error(MSG.nonePicked);
  try {
    await port.open({ baudRate: 115200 });
  } catch (e) {
    const name = e && e.name;
    const text = String((e && e.message) || '');
    if (name === 'InvalidStateError' && /already open/i.test(text)) return port;
    if (name === 'NetworkError' || name === 'SecurityError' || /claim|busy|in use|access denied/i.test(text)) {
      throw new Error(MSG.busy);
    }
    throw new Error(MSG.openFailed);
  }
  return port;
}

export async function closeBrain(port) {
  if (!port) return;
  // Locked streams cannot be closed; release anything the caller left behind.
  try { if (port.readable && port.readable.locked === false) await port.readable.cancel(); } catch (e) { /* ignore */ }
  try { if (port.writable && port.writable.locked === false) await port.writable.abort(); } catch (e) { /* ignore */ }
  try { await port.close(); } catch (e) { /* ignore */ }
  if (port.__usbDevice) {
    try { if (port.__usbDevice.opened) await port.__usbDevice.close(); } catch (e) { /* ignore */ }
  }
}
