/**
 * Shake / tilt / flip detection for whole-crew emergencies.
 *
 * Sensors are a bonus, never a requirement: iOS needs a permission prompt,
 * desktops have no accelerometer at all, and a denied prompt must not make the
 * game unwinnable. Every emergency also has a giant on-screen button.
 */
import { ALL_HANDS } from '/shared/protocol.js';

const SHAKE_THRESHOLD = 18; // m/s^2 of jerk, summed across axes
const TILT_DEGREES = 32;
const FLIP_GRAVITY = 6;

export class MotionWatcher {
  constructor(onTrigger) {
    this.onTrigger = onTrigger;
    this.armedKind = null;
    this.granted = false;
    this.last = null;
    this.baselineZ = null;

    this._onMotion = this._onMotion.bind(this);
    this._onOrientation = this._onOrientation.bind(this);
  }

  /** True if this device can contribute motion at all. */
  static get supported() {
    return typeof window.DeviceMotionEvent !== 'undefined';
  }

  /** Call from a user gesture. Resolves to whether we got sensor access. */
  async request() {
    if (this.granted) return true;
    if (!MotionWatcher.supported) return false;

    try {
      const needsPrompt = typeof DeviceMotionEvent.requestPermission === 'function';
      if (needsPrompt) {
        const state = await DeviceMotionEvent.requestPermission();
        if (state !== 'granted') return false;
      }
      window.addEventListener('devicemotion', this._onMotion, { passive: true });
      window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
      this.granted = true;
      return true;
    } catch {
      return false;
    }
  }

  arm(kind) {
    this.armedKind = kind;
    this.last = null;
    this.baselineZ = null;
  }

  disarm() {
    this.armedKind = null;
  }

  _fire(kind) {
    if (this.armedKind !== kind) return;
    this.armedKind = null;
    this.onTrigger(kind);
  }

  _onMotion(event) {
    if (!this.armedKind) return;
    const a = event.accelerationIncludingGravity;
    if (!a || a.x === null) return;

    if (this.armedKind === ALL_HANDS.SHAKE) {
      if (this.last) {
        const jerk =
          Math.abs(a.x - this.last.x) + Math.abs(a.y - this.last.y) + Math.abs(a.z - this.last.z);
        if (jerk > SHAKE_THRESHOLD) this._fire(ALL_HANDS.SHAKE);
      }
      this.last = { x: a.x, y: a.y, z: a.z };
      return;
    }

    if (this.armedKind === ALL_HANDS.FLIP) {
      // Which way is "up" differs by platform, so compare against how the phone
      // was held when the emergency started rather than an absolute sign.
      if (this.baselineZ === null) {
        if (Math.abs(a.z) > 4) this.baselineZ = Math.sign(a.z);
        return;
      }
      if (Math.abs(a.z) > FLIP_GRAVITY && Math.sign(a.z) !== this.baselineZ) {
        this._fire(ALL_HANDS.FLIP);
      }
    }
  }

  _onOrientation(event) {
    if (!this.armedKind || event.gamma === null) return;
    if (this.armedKind === ALL_HANDS.TILT_LEFT && event.gamma < -TILT_DEGREES) {
      this._fire(ALL_HANDS.TILT_LEFT);
    } else if (this.armedKind === ALL_HANDS.TILT_RIGHT && event.gamma > TILT_DEGREES) {
      this._fire(ALL_HANDS.TILT_RIGHT);
    }
  }
}
