// js/player.js
import { auth, db } from "./firebase.js";
import {
  ref,
  get,
  onValue,
  set,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

export class PlayerController {
  constructor(opts = {}) {
    // DOM elements (required)
    const el = opts.elements || {};
    this.el = {
      padGrid: el.padGrid || document.getElementById("padGrid"),
      playBtn: el.playBtn || document.getElementById("playBtn"),
      pauseBtn: el.pauseBtn || document.getElementById("pauseBtn"),
      stopBtn: el.stopBtn || document.getElementById("stopBtn"),
      trackHead: el.trackHead || document.getElementById("trackHead"),
      elapsedTime: el.elapsedTime || document.getElementById("elapsedTime"),
      totalTime: el.totalTime || document.getElementById("totalTime"),
      masterVolume: el.masterVolume || document.getElementById("masterVolume"),
      masterVolumeValue:
        el.masterVolumeValue || document.getElementById("masterVolumeValue"),
      busyCue: el.busyCue || document.getElementById("busyCue"),
      notifyEl: el.notifyEl || document.getElementById("notify"),
      signinBtn: el.signinBtn || document.getElementById("signinBtn"),
      logoutBtn: el.logoutBtn || document.getElementById("logoutBtn"),
      useRemote: el.useRemote || document.getElementById("useRemote"),
    };

    // config
    this.config = Object.assign(
      {
        padsJsonPath: "pads.json",
        fadeDuration: 1000,
        transitionStartTime: 2,
        preFadePadding: 2,
        dbPath: "/padplayer/current",
      },
      opts.config || {}
    );

    // state
    this.pads = [];
    this.currentPadBtn = null;
    this.currentAudio = null;
    this.transitioning = false;
    this.userSeeking = false;
    this.progressAnimating = false;
    this.nextLoopScheduled = false;
    this.masterVolume = parseFloat(this.el.masterVolume.value) || 1;
    this.remoteMode = false;
    this.remoteControl = false; // whether writes allowed (logged-in)
    this.remoteListenerRef = null;

    // bind UI
    this._bindUI();

    // load pads
    this._loadPads();
  }

  // bind UI events
  _bindUI() {
    // pad grid clicks delegated later when building buttons
    // control buttons
    this.el.playBtn.addEventListener("click", () => {
      if (!this._canLocalAction()) {
        this._notify(
          "Local actions are disabled during transition or in listen-only remote mode"
        );
        return;
      }
      this._onPlay();
    });
    this.el.pauseBtn.addEventListener("click", () => {
      if (!this._canLocalAction()) {
        this._notify(
          "Local actions are disabled during transition or in listen-only remote mode"
        );
        return;
      }
      this._onPause();
    });
    this.el.stopBtn.addEventListener("click", () => {
      if (!this._canLocalAction()) {
        this._notify(
          "Local actions are disabled during transition or in listen-only remote mode"
        );
        return;
      }
      this._onStop();
    });

    // master volume
    this.el.masterVolume.addEventListener("input", () => {
      this.masterVolume = parseFloat(this.el.masterVolume.value);
      this.el.masterVolumeValue.textContent = `${Math.round(
        this.masterVolume * 100
      )}%`;
      this._applyMasterVolumeToAll();
      if (this.remoteMode && this.remoteControl) {
        this._broadcastUpdate({
          lastChanged: "volume",
          volume: Math.round(this.masterVolume * 100),
        });
      }
    });

    // trackhead seeking
    this.el.trackHead.addEventListener("pointerdown", () => {
      this.userSeeking = true;
      this.el.trackHead.classList.add("dragging");
    });

    this.el.trackHead.addEventListener("input", () => {
      const pct = parseFloat(this.el.trackHead.value);
      this.el.trackHead.style.setProperty("--fill", `${pct}%`);
      if (this.currentAudio && this.currentAudio.duration) {
        const previewTime = (pct / 100) * this.currentAudio.duration;
        this.el.elapsedTime.textContent = this._formatTime(previewTime);
        this.el.totalTime.textContent = this._formatTime(
          this.currentAudio.duration
        );
      }
    });

    this.el.trackHead.addEventListener("pointerup", () => {
      if (!this.currentAudio || !this.currentAudio.duration) {
        this.userSeeking = false;
        this.el.trackHead.classList.remove("dragging");
        return;
      }
      if (this.transitioning || (this.remoteMode && !this.remoteControl)) {
        // disallow seek
        this._notify(
          "Seeking disabled during transition or in listen-only remote mode"
        );
        this.userSeeking = false;
        this.el.trackHead.classList.remove("dragging");
        return;
      }
      const pct = parseFloat(this.el.trackHead.value);
      const newTime = (pct / 100) * this.currentAudio.duration;
      this.currentAudio.currentTime = newTime;
      this.el.elapsedTime.textContent = this._formatTime(newTime);
      this.userSeeking = false;
      this.el.trackHead.classList.remove("dragging");
      this._startProgressLoop();

      // broadcast seek
      if (this.remoteMode && this.remoteControl) {
        this._broadcastUpdate({ lastChanged: "seeked", seeked: newTime });
      }
    });

    // remote toggle (checkbox)
    if (this.el.useRemote) {
      this.el.useRemote.addEventListener("change", async (e) => {
        const on = this.el.useRemote.checked;
        if (!on) {
          this.disableRemoteMode();
          return;
        }
        // if logged in, allow control, else listen-only
        const user = auth.currentUser;
        await this.enableRemoteMode(Boolean(user));
      });
    }

    // react to auth change (main page auth.js already does some UI; this keeps this controller updated)
    auth.onAuthStateChanged((u) => {
      this.remoteControl = !!u;
      this._applyMuteIfRemoteControl();
      // do not auto-toggle remote mode; user chooses via checkbox
    });
  }

  // load pads.json and build buttons
  async _loadPads() {
    try {
      const res = await fetch(this.config.padsJsonPath);
      this.pads = await res.json();
    } catch (e) {
      console.error("Failed to load pads.json", e);
      this.el.padGrid.innerHTML =
        '<div style="color:#f87171">Failed to load pads.json</div>';
      return;
    }

    // build pad buttons (grid)
    this.el.padGrid.innerHTML = "";
    this.pads.forEach((pad) => {
      const btn = document.createElement("button");
      btn.className = "pad-btn";
      btn.textContent = pad.key;
      btn.title = pad.name;
      btn.dataset.src = pad.path;
      btn.dataset.baseVolume =
        pad.volume !== undefined && !isNaN(pad.volume)
          ? String(Number(pad.volume))
          : "1";
      btn.addEventListener("click", () => this._onPadClick(btn));
      this.el.padGrid.appendChild(btn);
    });
    // ensure no scrolling — grid wraps; if many pads, they will wrap to fit.
  }

  // pad click handler
  async _onPadClick(btn) {
    if (!this._canLocalAction()) {
      this._notify("Local control disabled");
      return;
    }
    const src = btn.dataset.src;
    const baseVol = parseFloat(btn.dataset.baseVolume) || 1;
    await this._playPad(btn, src, baseVol);

    // broadcast
    if (this.remoteMode && this.remoteControl) {
      this._broadcastUpdate({
        key: btn.textContent,
        lastChanged: "key",
        status: "PLAYING",
      });
    }
  }

  // core playPad with crossfade + start@2s logic and per-track volume respect (master multiplied)
  async _playPad(btn, src, padBaseVolume = 1, transitionOverride = false) {
    if (this.transitioning && !transitionOverride) return;
    this._setBusy(true);

    console.log(btn, src)
    // update UI highlight
    if (this.currentPadBtn) this.currentPadBtn.classList.remove("active");
    btn.classList.add("active");
    this.currentPadBtn = btn;

    const newAudio = new Audio(src);
    newAudio.volume = 0;
    newAudio.muted = this.remoteControl && this.remoteMode;
    newAudio.preload = "auto";
    newAudio.autoplay = true;
    newAudio.dataset.baseVolume = padBaseVolume;
    // add to DOM for consistency
    document.body.appendChild(newAudio);

    try {
      await newAudio.play();
    } catch (err) {
      console.warn("play blocked", err);
      this._setBusy(false);
      try {
        newAudio.remove();
      } catch {}
      return;
    }

    const isTransition = !!this.currentAudio && this.currentAudio !== newAudio;

    if (isTransition) {
      // seek to transitionStartTime if duration allows
      const trySeek = () => {
        try {
          if (
            !isNaN(newAudio.duration) &&
            newAudio.duration > this.config.transitionStartTime
          ) {
            newAudio.currentTime = this.config.transitionStartTime;
          } else if (
            !isNaN(newAudio.duration) &&
            newAudio.duration <= this.config.transitionStartTime
          ) {
            newAudio.currentTime = 0;
          }
        } catch (e) {}
      };
      trySeek();
      newAudio.addEventListener("loadedmetadata", trySeek, { once: true });

      const effTarget = (padBaseVolume || 1) * this.masterVolume;
      await this._crossfadePromise(
        this.currentAudio,
        newAudio,
        this.config.fadeDuration,
        effTarget
      );
    } else {
      // first play
      const effTarget = (padBaseVolume || 1) * this.masterVolume;
      await this._fadeInPromise(newAudio, this.config.fadeDuration, effTarget);
    }

    this.currentAudio = newAudio;
    this._applyMuteIfRemoteControl();
    this._setBusy(false);

    // reset scheduling
    this.nextLoopScheduled = false;
    this._monitorEndForLoop();
    this._startProgressLoop();
  }

  // wrappers used by internal/external logic (keeps naming)
  async _playPadWrapper(btn, src, baseVol) {
    return this._playPad(btn, src, baseVol);
  }
  async _playPadPublic(btn, src, baseVol) {
    return this._playPad(btn, src, baseVol);
  }

  // play/pause/stop handlers
  _onPlay() {
    if (!this.currentAudio && this.el.padGrid.children.length) {
      const first = this.el.padGrid.children[0];
      this._onPadClick(first);
      return;
    }
    if (this.currentAudio) this.currentAudio.play();
    if (this.remoteMode && this.remoteControl)
      this._broadcastUpdate({ lastChanged: "status", status: "PLAYING" });
    this._startProgressLoop();
  }
  _onPause() {
    if (this.currentAudio) this.currentAudio.pause();
    if (this.remoteMode && this.remoteControl)
      this._broadcastUpdate({ lastChanged: "status", status: "PAUSED" });
  }
  _onStop() {
    if (this.transitioning) return;
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        this.currentAudio.volume = 0;
        this.currentAudio.remove();
      } catch (e) {}
      this.currentAudio = null;
    }
    if (this.currentPadBtn) {
      this.currentPadBtn.classList.remove("active");
      this.currentPadBtn = null;
    }
    // reset UI
    this.el.trackHead.value = 0;
    this.el.trackHead.style.setProperty("--fill", "0%");
    this.el.elapsedTime.textContent = "0:00";
    this.el.totalTime.textContent = "0:00";
    this.progressAnimating = false;
    if (this.remoteMode && this.remoteControl)
      this._broadcastUpdate({ lastChanged: "status", status: "STOPPED" });
  }

  // crossfade and fade helpers (rAF-based)
  _crossfadePromise(oldAudio, newAudio, durationMs, newTargetVol = 1) {
    return new Promise((resolve) => {
      if (!durationMs || durationMs <= 0) {
        try {
          newAudio.volume = newTargetVol;
        } catch (e) {}
        try {
          oldAudio.volume = 0;
          oldAudio.pause();
          oldAudio.remove();
        } catch (e) {}
        resolve();
        return;
      }
      const startTime = performance.now();
      const oldStart = Math.max(0, Math.min(1, oldAudio.volume ?? 1));
      const newStart = Math.max(0, Math.min(1, newAudio.volume ?? 0));
      const target = Math.max(0, Math.min(1, newTargetVol));

      const step = (now) => {
        const t = Math.min(1, Math.max(0, (now - startTime) / durationMs));
        const oldVol = oldStart + (0 - oldStart) * t;
        const newVol = newStart + (target - newStart) * t;
        try {
          newAudio.volume = newVol;
        } catch (e) {}
        try {
          oldAudio.volume = oldVol;
        } catch (e) {}
        if (t < 1) requestAnimationFrame(step);
        else {
          try {
            newAudio.volume = target;
          } catch (e) {}
          try {
            oldAudio.pause();
            oldAudio.remove();
          } catch (e) {}
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  _fadeInPromise(audio, durationMs, targetVol = 1) {
    return new Promise((resolve) => {
      if (!durationMs || durationMs <= 0) {
        try {
          audio.volume = targetVol;
        } catch (e) {}
        resolve();
        return;
      }
      const start = performance.now();
      const startVol = Math.max(0, Math.min(1, audio.volume ?? 0));
      const step = (now) => {
        const t = Math.min(1, Math.max(0, (now - start) / durationMs));
        const vol = startVol + (targetVol - startVol) * t;
        try {
          audio.volume = vol;
        } catch (e) {}
        if (t < 1) requestAnimationFrame(step);
        else {
          try {
            audio.volume = targetVol;
          } catch (e) {}
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  // master volume application
  _applyMasterVolumeToAll() {
    document.querySelectorAll("audio").forEach((a) => {
      const base = parseFloat(a.dataset.baseVolume) || 1;
      // if current fade is at 0 keep it; otherwise apply scaled volume
      // we avoid overriding fades heavily — fades set volume directly, but master moves should multiply base
      try {
        a.volume = Math.min(1, base * this.masterVolume);
      } catch (e) {}
    });
    this._applyMuteIfRemoteControl();
  }

  _applyMuteIfRemoteControl() {
    // If this client is a remote controller, mute all audio outputs locally.
    const shouldMute = this.remoteControl && this.remoteMode;
    document.querySelectorAll("audio").forEach((a) => {
      try {
        a.muted = shouldMute;
      } catch (e) {}
    });
  }

  // progress loop
  _startProgressLoop() {
    if (this.progressAnimating) return;
    this.progressAnimating = true;
    requestAnimationFrame(this._progressLoop.bind(this));
  }

  _progressLoop() {
    if (!this.currentAudio || this.currentAudio.paused) {
      this.progressAnimating = false;
      return;
    }
    if (!this.userSeeking && this.currentAudio.duration) {
      const pct =
        (this.currentAudio.currentTime / this.currentAudio.duration) * 100;
      this.el.trackHead.value = pct;
      this.el.trackHead.style.setProperty("--fill", `${pct}%`);
      this.el.elapsedTime.textContent = this._formatTime(
        this.currentAudio.currentTime
      );
      this.el.totalTime.textContent = this._formatTime(
        this.currentAudio.duration
      );
    }
    requestAnimationFrame(this._progressLoop.bind(this));
  }

  // loop scheduling: when reaching end - fadeDuration - preFadePadding, spawn next
  _monitorEndForLoop() {
    if (!this.currentAudio) return;
    // remove previous timeupdate handlers if any
    const handler = async () => {
      if (this.transitioning || this.nextLoopScheduled) return;
      if (!this.currentAudio || !this.currentAudio.duration) return;
      const remaining =
        this.currentAudio.duration - this.currentAudio.currentTime;
      const trigger =
        this.config.fadeDuration / 1000 + this.config.preFadePadding;
      if (remaining <= trigger) {
        this.nextLoopScheduled = true;
        // spawn same pad again
        if (this.currentPadBtn) {
          const src = this.currentPadBtn.dataset.src;
          const base = parseFloat(this.currentPadBtn.dataset.baseVolume) || 1;
          await this._playPad(this.currentPadBtn, src, base);
        }
      }
    };
    this.currentAudio._endMonitor = handler;
    this.currentAudio.addEventListener("timeupdate", handler);
  }

  // Firebase: enable/disable remote mode
  async enableRemoteMode(allowControl = false) {
    this.remoteMode = true;
    this.remoteControl = !!allowControl;
    // lock UI
    this._setBusy(true);
    // initial get
    await this._initialRemoteSync();
    // attach realtime listener
    this._attachRemoteListener();
    this._updateUILock();
    this._applyMuteIfRemoteControl();
    this._setBusy(false);
  }

  disableRemoteMode() {
    this.remoteMode = false;
    this.remoteControl = false;
    this._detachRemoteListener();
    if (this.el.useRemote) this.el.useRemote.checked = false;
    this._updateUILock();
    this._applyMuteIfRemoteControl();
  }

  async _initialRemoteSync() {
    try {
      const snap = await get(ref(db, this.config.dbPath));
      const val = snap.val();
      if (!val) return;
      // Apply same handler as realtime
      console.log("Initial remote sync", val);
      await this._handleRemoteUpdate(val, { initialGet: true });
    } catch (e) {
      console.warn("initial sync failed", e);
    }
  }

  _attachRemoteListener() {
    this._detachRemoteListener();
    const r = ref(db, this.config.dbPath);
    this.remoteListenerRef = onValue(r, async (snapshot) => {
      const val = snapshot.val();
      if (!val) return;
      // handle remote update
      await this._handleRemoteUpdate(val);
    });
  }

  _detachRemoteListener() {
    if (!this.remoteListenerRef) return;
    try {
      const r = ref(db, this.config.dbPath);
      r.off && r.off(); // not always present in modular ref; onValue returns unsubscribe normally
    } catch (e) {
      console.error(e)
    }
    this.remoteListenerRef = null;
  }

  // broadcast update (overwrite current node)
  _broadcastUpdate(obj) {
    if (!db) return;
    const now = Date.now();
    const payload = {
      key:
        obj.key || (this.currentPadBtn ? this.currentPadBtn.textContent : null),
      status:
        obj.status ||
        (this.currentAudio && !this.currentAudio.paused
          ? "PLAYING"
          : this.currentAudio
          ? "PAUSED"
          : "STOPPED"),
      volume:
        typeof obj.volume !== "undefined"
          ? obj.volume
          : Math.round(this.masterVolume * 100),
      timestamp: now,
      seeked: typeof obj.seeked !== "undefined" ? obj.seeked : null,
      lastChanged: obj.lastChanged || null,
    };
    try {
      set(ref(db, this.config.dbPath), payload);
    } catch (e) {
      console.warn("broadcast failed", e);
    }
  }

  // handle incoming remote updates
  async _handleRemoteUpdate(remoteObj, opts = {}) {
    if (!this.remoteMode) {
      return;
    }
    // notify logged-out listeners
    const notifyUser = !auth.currentUser && !this.remoteControl;

    const { key, status, volume, timestamp, seeked, lastChanged } = remoteObj;
    const now = Date.now();
    const ageMs = now - (timestamp || now);

    // find pad button by key
    const padBtn = key
      ? Array.from(this.el.padGrid.children).find((b) => b.textContent === key)
      : null;


    // handle volume changes (master)
    if (typeof volume !== "undefined" && volume !== null) {
      const newMaster = Math.max(0, Math.min(100, Number(volume))) / 100;
      this._rampMasterVolumeTo(newMaster, 600);
      if (notifyUser)
        this._notify(
          `Remote changed master volume to ${Math.round(newMaster * 100)}%`
        );
    }

    // handle seek (lastChanged === 'seeked' or seeked not null)
    if (
      (lastChanged === "seeked" && seeked != null) ||
      (seeked != null && lastChanged === "seeked")
    ) {
      // compute expected playhead by adding age
      const target = Number(seeked) + ageMs / 1000;
      await this._applyRemoteSeek(target, { padKey: key });
      if (notifyUser)
        this._notify(`Remote seeked to ${this._formatTime(target)}`);
    }

    // handle key transitions
    if (lastChanged === "key" && padBtn ) {
      // remote transition: spawn new audio at transitionStartTime and crossfade
      const padBase = parseFloat(padBtn.dataset.baseVolume) || 1;
      await this._playPad(padBtn, padBtn.dataset.src, padBase, opts.initialGet);
      if (notifyUser) this._notify(`Remote transitioned to ${key}`);
    }

    // handle status
    if (lastChanged === "status" || status) {
      if (status === "PAUSED") {
        if (this.currentAudio) this.currentAudio.pause();
        if (notifyUser) this._notify("Remote paused audio");
      } else if (status === "STOPPED") {
        this._onStop();
        if (notifyUser) this._notify("Remote stopped audio");
      } else if (status === "PLAYING") {
        if (this.currentAudio) this.currentAudio.play().catch(() => {});
        if (notifyUser) this._notify("Remote resumed playing");
      }
    }

    if (opts.initialGet) {
      if (this.currentAudio) this._startProgressLoop();
    }
  }

  // ramp master volume smoothly
  _rampMasterVolumeTo(target, durationMs = 600) {
    const start = performance.now();
    const from = this.masterVolume;
    const dur = Math.max(1, durationMs);
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      this.masterVolume = from + (target - from) * t;
      // apply to audios using their base volumes
      document.querySelectorAll("audio").forEach((a) => {
        const base = parseFloat(a.dataset.baseVolume) || 1;
        try {
          a.volume = base * this.masterVolume;
        } catch (e) {}
      });
      this.el.masterVolume.value = this.masterVolume;
      this.el.masterVolumeValue.textContent = `${Math.round(
        this.masterVolume * 100
      )}%`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // handle remote seek by spawning new audio at computed time (no scrubbing)
  async _applyRemoteSeek(targetTimeSeconds, opts = {}) {
    const padBtn =
      this.currentPadBtn ||
      (opts.padKey
        ? Array.from(this.el.padGrid.children).find(
            (b) => b.textContent === opts.padKey
          )
        : null) ||
      this.el.padGrid.children[0];
    if (!padBtn) return;

    const src = padBtn.dataset.src;
    const padBase = parseFloat(padBtn.dataset.baseVolume) || 1;

    // Create new audio
    const newAudio = new Audio(src);
    newAudio.volume = 0;
    newAudio.preload = "auto";
    newAudio.muted = this.remoteControl && this.remoteMode;
    newAudio.autoplay = true;
    newAudio.dataset.baseVolume = padBase;
    document.body.appendChild(newAudio);

    try {
      await newAudio.play();
    } catch (e) {
      console.warn("play blocked", e);
      newAudio.remove();
      return;
    }

    // Attempt to set playback time
    const setTime = () => {
      try {
        const dur = newAudio.duration;
        if (isNaN(dur) || dur === 0) return false;
        let t = targetTimeSeconds;
        if (t >= dur) t = t % dur;
        if (t < 0) t = 0;
        newAudio.currentTime = t;
        return true;
      } catch (e) {
        return false;
      }
    };

    if (!setTime()) {
      await new Promise((res) => {
        const handler = () => {
          setTime();
          newAudio.removeEventListener("loadedmetadata", handler);
          res();
        };
        newAudio.addEventListener("loadedmetadata", handler);
        setTimeout(res, 1000);
      });
    }

    const effTarget = padBase * this.masterVolume;

    // Perform fade/crossfade and clean up old audio
    const oldAudio = this.currentAudio;
    if (oldAudio)
      await this._crossfadePromise(
        oldAudio,
        newAudio,
        this.config.fadeDuration,
        effTarget
      );
    else
      await this._fadeInPromise(newAudio, this.config.fadeDuration, effTarget);

    // Ensure the old audio element is removed
    if (oldAudio) {
      try {
        oldAudio.pause();
        oldAudio.removeEventListener("timeupdate", oldAudio._endMonitor);
        oldAudio.remove();
      } catch (e) {}
    }

    // Update current references and reset loop system
    this.currentAudio = newAudio;
    this._applyMuteIfRemoteControl();
    this.nextLoopScheduled = false;

    // Start monitoring for end loop and progress updates
    this._monitorEndForLoop();
    this._startProgressLoop();
  }

  // notify helper
  _notify(msg, ttl = 3500) {
    if (!this.el.notifyEl) return;
    this.el.notifyEl.textContent = msg;
    this.el.notifyEl.style.display = "block";
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => {
      this.el.notifyEl.style.display = "none";
    }, ttl);
  }

  // set busy: disable UI and show busy cue
  _setBusy(on) {
    this.transitioning = on;
    const locked = on || (this.remoteMode && !this.remoteControl);
    document.querySelectorAll(".pad-btn").forEach((b) => (b.disabled = locked));
    [this.el.playBtn, this.el.pauseBtn, this.el.stopBtn, this.el.masterVolume].forEach(
      (b) => (b.disabled = locked)
    );

    this.el.useRemote.disabled = this.transitioning;
    this.el.trackHead.disabled = locked;
    if (this.el.masterVolume) this.el.masterVolume.disabled = locked;
    if (this.el.busyCue) this.el.busyCue.style.display = on ? "block" : "none";
    document.body.classList.toggle("transitioning", on);
  }

  _updateUILock() {
    const locked = this.remoteMode && !this.remoteControl;
    document.querySelectorAll(".pad-btn").forEach((b) => (b.disabled = locked));
    [
      this.el.playBtn,

      this.el.pauseBtn,
      this.el.stopBtn,
      this.el.masterVolume,
    ].forEach((b) => (b.disabled = locked));
    this.el.trackHead.disabled = locked;
  }

  _canLocalAction() {
    if (this.remoteMode && !this.remoteControl) return false;
    if (this.transitioning) return false;
    return true;
  }

  onAuthStateChanged(user) {
    this.remoteControl = !!user;
  }

  _formatTime(sec) {
    if (!isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
}
