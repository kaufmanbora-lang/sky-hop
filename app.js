(function () {
  "use strict";

  var STORAGE_KEY = "sky-hop-profile-v1";
  var DEVICE_KEY = "sky-hop-device-v1";
  var GAME_WIDTH = 600;
  var GAME_HEIGHT = 600;
  var PIPE_WIDTH = 86;
  var BIRD_X = 154;
  var BIRD_RENDER_WIDTH = 76;
  var COLLISION_ALPHA_THRESHOLD = 140;
  var PLAY_FLOOR = GAME_HEIGHT - 8;
  var STARTING_LIVES = 2;
  var HIT_GRACE_MS = 1350;
  var HEART_PIPE_INTERVAL = 100;
  var TOTAL_PIPES = 1000;
  var desktopMode = new URLSearchParams(window.location.search).get("desktop") === "1";

  var DIFFICULTIES = {
    easy: {
      id: "easy", label: "ЛЁГКИЙ", shortLabel: "ЛЕГКО", lives: 4,
      gapBase: 230, gapShrink: 2.2, spacingBase: 252, spacingShrink: 1.5,
      speedBase: 104, speedGrowth: 4.5, modifierChance: 0.55
    },
    medium: {
      id: "medium", label: "СРЕДНИЙ", shortLabel: "СРЕДНЕ", lives: 2,
      gapBase: 180, gapShrink: 4.1, spacingBase: 238, spacingShrink: 3,
      speedBase: 126, speedGrowth: 7.5, modifierChance: 1
    },
    hard: {
      id: "hard", label: "ХАРДКОР", shortLabel: "ХАРД", lives: 1,
      gapBase: 124, gapShrink: 1.6, spacingBase: 210, spacingShrink: 3.5,
      speedBase: 154, speedGrowth: 9.5, modifierChance: 1.45
    }
  };

  var TRAILS = [
    { id: "classic", name: "НЕБЕСНЫЙ", description: "Сине-жёлтые искры", price: 0, asset: null },
    { id: "gold", name: "ЗОЛОТОЙ", description: "Звёздная пыль", price: 100, asset: "star" },
    { id: "galaxy", name: "СВЕРХГАЛАКТИЧЕСКИЙ", description: "Планеты и космос", price: 200, asset: "planet" },
    { id: "cards", name: "КАРТОЧНЫЙ", description: "Красный след и карты", price: 300, asset: "card" }
  ];

  var RANKS = [
    { name: "НОВИЧОК", threshold: 0, medal: "◉" },
    { name: "ЛЁТЧИК", threshold: 250, medal: "✦" },
    { name: "ВОЗДУШНЫЙ АС", threshold: 1000, medal: "★" },
    { name: "ШТУРМАН БУРИ", threshold: 3000, medal: "◆" },
    { name: "МАСТЕР НЕБА", threshold: 10000, medal: "✹" },
    { name: "ГАЛАКТИЧЕСКИЙ ЧЕМПИОН", threshold: 30000, medal: "♄" },
    { name: "НЕБЕСНЫЙ ТИТАН", threshold: 100000, medal: "♛" }
  ];

  var dom = {};
  var profile = null;
  var currentScreen = "menu-screen";
  var toastTimer = 0;
  var victoryRevealTimer = 0;
  var sensorGesture = {
    activePointers: {},
    startedAt: 0,
    maxFingers: 0,
    moved: false,
    pendingTwoFingerTimer: 0,
    pendingContextMenuTimer: 0,
    ignoreCanvasClickUntil: 0,
    lastTouchGestureAt: 0
  };
  var assets = {};
  var assetsPromise = null;
  var collisionMasks = { birdPoints: [], pipe: null };

  var game = {
    status: "idle",
    bird: { x: BIRD_X, y: 292, vy: 0, rotation: 0 },
    pipes: [],
    particles: [],
    impact: null,
    lives: STARTING_LIVES,
    invulnerableUntil: 0,
    nextPipeNumber: 0,
    score: 0,
    earned: 0,
    sector: 1,
    reverseUntil: 0,
    speedUntil: 0,
    lastTime: 0,
    lastTrailAt: 0,
    dyingAt: 0,
    rankCelebratingUntil: 0,
    pendingVictoryRank: null,
    animationId: 0,
    backgroundReady: false
  };

  var audio = {
    context: null,
    buffers: {},
    assetsPromise: null,
    musicSource: null,
    musicGain: null,
    userActivated: false,

    ensure: function () {
      if (!profile || !profile.soundEnabled) return null;
      if (!this.context) {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return null;
        this.context = new AudioContext();
      }
      if (this.context.state === "suspended") this.context.resume();
      return this.context;
    },

    activate: function () {
      this.userActivated = true;
      if (!profile || !profile.soundEnabled) return;
      var ctx = this.ensure();
      if (!ctx) return;
      var self = this;
      var resumed = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
      Promise.resolve(resumed)
        .then(function () { return self.loadAssets(); })
        .then(function () { self.startMusic(); })
        .catch(function () {});
    },

    loadAssets: function () {
      var self = this;
      var ctx = self.ensure();
      if (!ctx) return Promise.resolve();
      if (self.assetsPromise) return self.assetsPromise;
      var files = {
        soundtrack: "assets/sky-hop-dreamflight.wav",
        chirp: "assets/bird-chirp-soft-v2.wav"
      };
      self.assetsPromise = Promise.all(Object.keys(files).map(function (name) {
        return fetch(files[name])
          .then(function (response) {
            if (!response.ok) throw new Error("Audio asset failed: " + files[name]);
            return response.arrayBuffer();
          })
          .then(function (bytes) { return ctx.decodeAudioData(bytes); })
          .then(function (buffer) { self.buffers[name] = buffer; });
      })).catch(function () {
        self.assetsPromise = null;
      });
      return self.assetsPromise;
    },

    playBuffer: function (name, volume) {
      var ctx = this.ensure();
      var buffer = this.buffers[name];
      if (!ctx || !buffer) return false;
      var source = ctx.createBufferSource();
      var gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.value = volume;
      source.connect(gain).connect(ctx.destination);
      source.start();
      return true;
    },

    tone: function (frequency, duration, volume, type, delay, endFrequency) {
      var ctx = this.ensure();
      if (!ctx) return;
      var start = ctx.currentTime + (delay || 0);
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(frequency, start);
      if (endFrequency) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.03);
    },

    noise: function (duration, volume) {
      var ctx = this.ensure();
      if (!ctx) return;
      var length = Math.floor(ctx.sampleRate * duration);
      var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      var source = ctx.createBufferSource();
      var filter = ctx.createBiquadFilter();
      var gain = ctx.createGain();
      filter.type = "lowpass";
      filter.frequency.value = 720;
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      source.buffer = buffer;
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start();
    },

    flap: function () {
      if (this.playBuffer("chirp", 0.46)) return;
      this.tone(455, 0.19, 0.034, "sine", 0, 625);
    },

    dive: function () {
      this.tone(310, 0.08, 0.025, "sine", 0, 220);
    },

    point: function () {
      this.tone(840, 0.07, 0.024, "triangle", 0, 1040);
    },

    modifier: function () {
      this.tone(390, 0.09, 0.03, "sine", 0, 650);
      this.tone(650, 0.12, 0.025, "sine", 0.08, 920);
    },

    heart: function () {
      this.tone(620, 0.1, 0.035, "sine", 0, 840);
      this.tone(840, 0.14, 0.03, "triangle", 0.08, 1160);
    },

    lifeLost: function () {
      this.noise(0.11, 0.043);
      this.tone(330, 0.15, 0.055, "triangle", 0, 145);
      this.tone(690, 0.08, 0.027, "sine", 0.02, 410);
    },

    collision: function () {
      this.noise(0.22, 0.085);
      this.tone(230, 0.12, 0.07, "square", 0, 92);
      this.tone(145, 0.28, 0.075, "sawtooth", 0.07, 48);
      this.tone(86, 0.72, 0.048, "triangle", 0.2, 32);
    },

    rankUp: function () {
      this.tone(392, 0.42, 0.045, "sine", 0, 523.25);
      this.tone(523.25, 0.45, 0.05, "triangle", 0.14, 659.25);
      this.tone(659.25, 0.55, 0.052, "sine", 0.3, 783.99);
      this.tone(783.99, 1.15, 0.046, "triangle", 0.48, 1046.5);
      this.tone(196, 1.3, 0.035, "sine", 0.25, 261.63);
    },

    victory: function () {
      this.tone(392, 0.48, 0.04, "sine", 0, 523.25);
      this.tone(523.25, 0.55, 0.045, "triangle", 0.16, 659.25);
      this.tone(659.25, 0.7, 0.05, "sine", 0.34, 783.99);
      this.tone(783.99, 1.4, 0.045, "triangle", 0.55, 1174.66);
    },

    startMusic: function () {
      var self = this;
      if (!self.userActivated || !profile || !profile.soundEnabled || self.musicSource || document.hidden) return;
      var ctx = self.ensure();
      if (!ctx) return;
      if (!self.buffers.soundtrack) {
        self.loadAssets().then(function () { self.startMusic(); });
        return;
      }
      var source = ctx.createBufferSource();
      var gain = ctx.createGain();
      source.buffer = self.buffers.soundtrack;
      source.loop = true;
      gain.gain.value = 0.38;
      source.connect(gain).connect(ctx.destination);
      self.musicSource = source;
      self.musicGain = gain;
      source.start();
    },

    stopMusic: function () {
      if (this.musicSource) {
        try { this.musicSource.stop(); } catch (error) {}
        try { this.musicSource.disconnect(); } catch (error) {}
      }
      if (this.musicGain) {
        try { this.musicGain.disconnect(); } catch (error) {}
      }
      this.musicSource = null;
      this.musicGain = null;
    }
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    profile = loadOrCreateDeviceProfile();
    configureInputMode();
    bindEvents();
    showMenu();
  }

  function configureInputMode() {
    if (!desktopMode) return;
    document.body.classList.add("desktop-mode");
    document.getElementById("up-control-hint").innerHTML = "<b>ПРОБЕЛ</b> • ВВЕРХ ↑";
    document.getElementById("down-control-hint").innerHTML = "<b>CTRL</b> • ВНИЗ ↓";
    dom.canvas.setAttribute("aria-label", "Sky Hop, компьютерный тест. Пробел — вверх, Control — вниз");
  }

  function cacheDom() {
    dom.app = document.getElementById("app");
    dom.menuDevice = document.getElementById("menu-device");
    dom.canvas = document.getElementById("game-canvas");
    dom.ctx = dom.canvas.getContext("2d", { alpha: false, desynchronized: true });
    dom.startOverlay = document.getElementById("start-overlay");
    dom.gameOverOverlay = document.getElementById("game-over-overlay");
    dom.victoryOverlay = document.getElementById("victory-overlay");
    dom.victoryVideo = document.getElementById("victory-video");
    dom.winnerTitle = document.getElementById("winner-title");
    dom.livesBlock = document.getElementById("lives-block");
    dom.livesValue = document.getElementById("lives-value");
    dom.difficultyHudLabel = document.getElementById("difficulty-hud-label");
    dom.livesHelp = document.getElementById("lives-help");
    dom.rankCelebration = document.getElementById("rank-celebration");
    dom.rankCelebrationMedal = document.getElementById("rank-celebration-medal");
    dom.rankCelebrationName = document.getElementById("rank-celebration-name");
    dom.modifierBadge = document.getElementById("modifier-badge");
    dom.scoreValue = document.getElementById("score-value");
    dom.goalProgress = document.getElementById("goal-progress");
    dom.runWallet = document.getElementById("run-wallet");
    dom.sectorLabel = document.getElementById("sector-label");
    dom.sectorProgress = document.getElementById("sector-progress");
    dom.sectorFill = document.getElementById("sector-fill");
    dom.toast = document.getElementById("toast");
  }

  function bindEvents() {
    document.addEventListener("click", function (event) {
      audio.activate();
      var actionTarget = event.target.closest("[data-action]");
      if (actionTarget) {
        handleAction(actionTarget.dataset.action, actionTarget);
        return;
      }
      if (event.target === dom.canvas && game.status === "running" && performance.now() >= sensorGesture.ignoreCanvasClickUntil) applyUpCommand();
    });

    dom.canvas.addEventListener("pointerdown", handleSensorPointerDown, { passive: false });
    dom.canvas.addEventListener("pointermove", handleSensorPointerMove, { passive: false });
    dom.canvas.addEventListener("pointerup", handleSensorPointerUp, { passive: false });
    dom.canvas.addEventListener("pointercancel", handleSensorPointerCancel, { passive: false });
    dom.canvas.addEventListener("contextmenu", handleSensorContextMenu, { passive: false });
    dom.canvas.addEventListener("dblclick", handleSensorDoubleClick, { passive: false });

    dom.victoryVideo.addEventListener("ended", revealVictoryFinal);
    dom.victoryVideo.addEventListener("error", revealVictoryFinal);

    document.addEventListener("keydown", handleKeyDown, { passive: false });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        game.lastTime = 0;
        audio.stopMusic();
      } else {
        audio.startMusic();
      }
    });
  }

  function handleSensorPointerDown(event) {
    if (currentScreen !== "game-screen" || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    event.preventDefault();
    audio.activate();
    if (!sensorGesture.startedAt) {
      sensorGesture.startedAt = performance.now();
      sensorGesture.maxFingers = 0;
      sensorGesture.moved = false;
    }
    sensorGesture.activePointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    sensorGesture.maxFingers = Math.max(sensorGesture.maxFingers, Object.keys(sensorGesture.activePointers).length);
    sensorGesture.ignoreCanvasClickUntil = performance.now() + 700;
    if (sensorGesture.maxFingers >= 2 && sensorGesture.pendingTwoFingerTimer) {
      window.clearTimeout(sensorGesture.pendingTwoFingerTimer);
      sensorGesture.pendingTwoFingerTimer = 0;
      showMenu();
      return;
    }
    try { dom.canvas.setPointerCapture(event.pointerId); } catch (error) {}
  }

  function handleSensorPointerMove(event) {
    var start = sensorGesture.activePointers[event.pointerId];
    if (!start) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 24) sensorGesture.moved = true;
  }

  function handleSensorPointerUp(event) {
    if (!sensorGesture.activePointers[event.pointerId]) return;
    event.preventDefault();
    delete sensorGesture.activePointers[event.pointerId];
    if (Object.keys(sensorGesture.activePointers).length) return;

    var duration = performance.now() - sensorGesture.startedAt;
    var fingers = sensorGesture.maxFingers;
    var moved = sensorGesture.moved;
    sensorGesture.startedAt = 0;
    sensorGesture.maxFingers = 0;
    sensorGesture.moved = false;
    sensorGesture.lastTouchGestureAt = performance.now();
    if (!moved && duration <= 480) handleSensorTap(fingers);
  }

  function handleSensorPointerCancel(event) {
    if (!sensorGesture.activePointers[event.pointerId]) return;
    delete sensorGesture.activePointers[event.pointerId];
    if (!Object.keys(sensorGesture.activePointers).length) resetActiveSensorPointers();
  }

  function handleSensorContextMenu(event) {
    if (currentScreen !== "game-screen") return;
    event.preventDefault();
    if (performance.now() - sensorGesture.lastTouchGestureAt < 700) return;
    audio.activate();
    sensorGesture.ignoreCanvasClickUntil = performance.now() + 700;
    if (sensorGesture.pendingContextMenuTimer) {
      window.clearTimeout(sensorGesture.pendingContextMenuTimer);
      sensorGesture.pendingContextMenuTimer = 0;
      showMenu();
      return;
    }
    sensorGesture.pendingContextMenuTimer = window.setTimeout(function () {
      sensorGesture.pendingContextMenuTimer = 0;
      if (currentScreen === "game-screen") applyDownCommand();
    }, 650);
  }

  function handleSensorDoubleClick(event) {
    if (currentScreen !== "game-screen" || event.button !== 2) return;
    event.preventDefault();
    clearPendingSensorGesture();
    showMenu();
  }

  function handleSensorTap(fingers) {
    if (currentScreen !== "game-screen") return;
    if (fingers >= 2) {
      if (sensorGesture.pendingTwoFingerTimer) {
        window.clearTimeout(sensorGesture.pendingTwoFingerTimer);
        sensorGesture.pendingTwoFingerTimer = 0;
        showMenu();
        return;
      }
      sensorGesture.pendingTwoFingerTimer = window.setTimeout(function () {
        sensorGesture.pendingTwoFingerTimer = 0;
        if (currentScreen === "game-screen") applyDownCommand();
      }, 340);
      return;
    }
    applyUpCommand();
  }

  function resetActiveSensorPointers() {
    sensorGesture.activePointers = {};
    sensorGesture.startedAt = 0;
    sensorGesture.maxFingers = 0;
    sensorGesture.moved = false;
  }

  function clearPendingSensorGesture() {
    if (sensorGesture.pendingTwoFingerTimer) window.clearTimeout(sensorGesture.pendingTwoFingerTimer);
    if (sensorGesture.pendingContextMenuTimer) window.clearTimeout(sensorGesture.pendingContextMenuTimer);
    sensorGesture.pendingTwoFingerTimer = 0;
    sensorGesture.pendingContextMenuTimer = 0;
    resetActiveSensorPointers();
  }

  function handleKeyDown(event) {
    audio.activate();
    var key = event.key;
    var active = document.activeElement;
    var isText = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");

    if (currentScreen === "game-screen") {
      if ((game.status === "over" || game.status === "victory") && performance.now() < game.rankCelebratingUntil) {
        event.preventDefault();
        return;
      }
      if (game.status === "victory" && dom.victoryOverlay.classList.contains("video-playing")) {
        event.preventDefault();
        if (key === "Escape") showMenu();
        return;
      }
      if (key === "Enter" || key === " " || key === "ArrowUp") {
        event.preventDefault();
        if (game.status === "running") applyUpCommand();
        else if (game.status === "over") restartGame();
        else if (game.status === "victory") restartGame();
        return;
      }
      if (key === "Control") {
        event.preventDefault();
        if (game.status === "running") applyDownCommand();
        return;
      }
      if (key === "Escape" || key === "ArrowDown") {
        event.preventDefault();
        if (game.status === "running") applyDownCommand();
        else if (game.status === "over" || game.status === "victory" || game.status === "ready") showMenu();
        return;
      }
      if (game.status === "dying") {
        event.preventDefault();
        return;
      }
    }

    if (key === "Escape") {
      event.preventDefault();
      navigateBack();
      return;
    }

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(key) !== -1) {
      event.preventDefault();
      var direction = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
      if ((currentScreen === "results-screen" || currentScreen === "ranks-screen") && !visibleFocusables(document.getElementById(currentScreen)).length) {
        var scrollArea = document.getElementById(currentScreen).querySelector(".scroll-container");
        if (scrollArea) scrollArea.scrollBy({ top: direction * 88, behavior: "smooth" });
      } else {
        moveFocus(direction);
      }
      return;
    }

    if (key === "Enter" && !isText) {
      var focus = document.activeElement;
      if (focus && focus.classList.contains("focusable")) {
        event.preventDefault();
        focus.click();
      }
    }
  }

  function handleAction(action, target) {
    audio.activate();
    if (action === "start-game") startGame();
    if (action === "launch-run") launchRun();
    if (action === "restart-game") restartGame();
    if (action === "return-menu") showMenu();
    if (action === "show-results") showResults();
    if (action === "show-shop") showShop();
    if (action === "show-ranks") showRanks();
    if (action === "toggle-sound") toggleSound();
    if (action === "select-difficulty") selectDifficulty(target.dataset.difficulty);
    if (action === "trail") handleTrail(target.dataset.trail);
  }

  function navigateTo(screenId, focusSelector) {
    if (currentScreen === "game-screen" && screenId !== "game-screen") stopGameLoop();
    var screens = document.querySelectorAll(".screen");
    for (var i = 0; i < screens.length; i += 1) screens[i].classList.remove("active");
    var screen = document.getElementById(screenId);
    screen.classList.add("active");
    currentScreen = screenId;
    window.setTimeout(function () {
      var focus = focusSelector ? screen.querySelector(focusSelector) : firstFocusable(screen);
      if (focus) focus.focus({ preventScroll: true });
    }, 30);
  }

  function navigateBack() {
    if (["results-screen", "shop-screen", "ranks-screen"].indexOf(currentScreen) !== -1) {
      showMenu();
    }
  }

  function firstFocusable(container) {
    var nodes = visibleFocusables(container);
    return nodes.length ? nodes[0] : null;
  }

  function visibleFocusables(container) {
    var all = Array.prototype.slice.call(container.querySelectorAll(".focusable:not([disabled])"));
    return all.filter(function (node) {
      return !node.classList.contains("hidden") && node.offsetParent !== null;
    });
  }

  function moveFocus(direction) {
    var screen = document.getElementById(currentScreen);
    var nodes = visibleFocusables(screen);
    if (!nodes.length) return;
    var index = nodes.indexOf(document.activeElement);
    index = index < 0 ? 0 : (index + direction + nodes.length) % nodes.length;
    nodes[index].focus();
    nodes[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }

  function randomHex(length) {
    var bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function getDeviceId() {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = randomHex(18);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function defaultProfile(deviceId) {
    return {
      version: 2,
      device: { id: deviceId, createdAt: new Date().toISOString() },
      wallet: 0,
      lifetimePipes: 0,
      scores: [],
      ownedTrails: ["classic"],
      equippedTrail: "classic",
      difficulty: "medium",
      hasWon: false,
      wins: 0,
      soundEnabled: true
    };
  }

  function loadProfile() {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!data) return null;
      data.wallet = Number(data.wallet) || 0;
      data.lifetimePipes = Number(data.lifetimePipes) || 0;
      data.scores = Array.isArray(data.scores) ? data.scores : [];
      data.ownedTrails = Array.isArray(data.ownedTrails) ? data.ownedTrails : ["classic"];
      data.equippedTrail = data.equippedTrail || "classic";
      data.difficulty = DIFFICULTIES[data.difficulty] ? data.difficulty : "medium";
      data.hasWon = data.hasWon === true;
      data.wins = Number(data.wins) || 0;
      data.soundEnabled = data.soundEnabled !== false;
      return data;
    } catch (error) {
      return null;
    }
  }

  function loadOrCreateDeviceProfile() {
    var deviceId = getDeviceId();
    var saved = loadProfile();
    if (!saved) saved = defaultProfile(deviceId);
    var originalCreatedAt = saved.device && saved.device.createdAt
      ? saved.device.createdAt
      : saved.account && saved.account.createdAt
        ? saved.account.createdAt
        : new Date().toISOString();
    saved.version = 2;
    saved.device = { id: deviceId, createdAt: originalCreatedAt };
    if (saved.account) delete saved.account;
    localStorage.removeItem("sky-hop-session-v1");
    profile = saved;
    saveProfile();
    return saved;
  }

  function saveProfile() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  }

  function showMenu() {
    clearPendingSensorGesture();
    hideVictoryOverlay();
    renderMenu();
    navigateTo("menu-screen", "[data-action='start-game']");
    audio.startMusic();
  }

  function renderMenu() {
    if (!profile) return;
    dom.winnerTitle.classList.toggle("hidden", !profile.hasWon);
    dom.menuDevice.textContent = "ОЧКИ • " + profile.device.id.slice(-6).toUpperCase();
    document.getElementById("wallet-value").textContent = formatNumber(profile.wallet);
    document.getElementById("sound-label").textContent = profile.soundEnabled ? "ЗВУК: ВКЛ" : "ЗВУК: ВЫКЛ";
    var difficultyButtons = document.querySelectorAll("[data-action='select-difficulty']");
    for (var i = 0; i < difficultyButtons.length; i += 1) {
      var selected = difficultyButtons[i].dataset.difficulty === profile.difficulty;
      difficultyButtons[i].classList.toggle("active", selected);
      difficultyButtons[i].setAttribute("aria-pressed", selected ? "true" : "false");
    }
    var progress = rankProgress(profile.lifetimePipes);
    document.getElementById("menu-rank").textContent = progress.current.name;
    document.getElementById("rank-progress-fill").style.width = Math.round(progress.percent * 100) + "%";
    document.getElementById("rank-progress-text").textContent = progress.next
      ? formatNumber(profile.lifetimePipes) + " / " + formatNumber(progress.next.threshold) + " труб"
      : "МАКСИМАЛЬНЫЙ РАНГ";
  }

  function rankFor(total) {
    var rank = RANKS[0];
    for (var i = 0; i < RANKS.length; i += 1) if (total >= RANKS[i].threshold) rank = RANKS[i];
    return rank;
  }

  function rankProgress(total) {
    var index = RANKS.indexOf(rankFor(total));
    var current = RANKS[index];
    var next = RANKS[index + 1] || null;
    var percent = next ? (total - current.threshold) / (next.threshold - current.threshold) : 1;
    return { current: current, next: next, percent: Math.max(0, Math.min(1, percent)) };
  }

  function toggleSound() {
    profile.soundEnabled = !profile.soundEnabled;
    if (!profile.soundEnabled) audio.stopMusic();
    else audio.activate();
    saveProfile();
    renderMenu();
    showToast(profile.soundEnabled ? "Звук включён" : "Звук выключен");
  }

  function selectDifficulty(difficultyId) {
    if (!DIFFICULTIES[difficultyId] || profile.difficulty === difficultyId) return;
    profile.difficulty = difficultyId;
    saveProfile();
    renderMenu();
    audio.point();
    showToast("РЕЖИМ: " + DIFFICULTIES[difficultyId].label);
  }

  function showResults() {
    renderResults();
    navigateTo("results-screen");
  }

  function renderResults() {
    var list = document.getElementById("results-list");
    list.innerHTML = "";
    var scores = profile.scores.slice().sort(function (a, b) { return b.score - a.score || b.timestamp - a.timestamp; });
    if (!scores.length) {
      var empty = document.createElement("li");
      empty.className = "empty-results";
      empty.textContent = "Первый рекорд ещё впереди";
      list.appendChild(empty);
    } else {
      scores.forEach(function (entry) {
        var row = document.createElement("li");
        row.className = "result-row" + (entry.victory ? " victory-result" : "");
        var score = document.createElement("span");
        score.className = "result-score";
        score.textContent = (entry.victory ? "🏆 " : "") + formatNumber(entry.score);
        var date = document.createElement("time");
        date.className = "result-date";
        date.dateTime = new Date(entry.timestamp).toISOString();
        date.textContent = formatDate(entry.timestamp);
        row.appendChild(score);
        row.appendChild(date);
        list.appendChild(row);
      });
    }
    var totalNode = document.getElementById("lifetime-total");
    totalNode.textContent = formatNumber(profile.lifetimePipes);
    totalNode.parentElement.lastChild.textContent = " " + pipeWord(profile.lifetimePipes).toUpperCase();
  }

  function showShop() {
    renderShop();
    navigateTo("shop-screen");
  }

  function renderShop() {
    document.getElementById("shop-wallet").textContent = formatNumber(profile.wallet);
    var list = document.getElementById("shop-list");
    list.innerHTML = "";
    TRAILS.forEach(function (trail) {
      var owned = profile.ownedTrails.indexOf(trail.id) !== -1;
      var equipped = profile.equippedTrail === trail.id;
      var button = document.createElement("button");
      button.className = "focusable shop-card" + (equipped ? " equipped" : "");
      button.dataset.action = "trail";
      button.dataset.trail = trail.id;
      button.setAttribute("aria-label", trail.name + ". " + (equipped ? "Выбран" : owned ? "Купить не требуется, выбрать" : "Цена " + trail.price));
      button.innerHTML = trailPreviewMarkup(trail) +
        "<span class='shop-copy'><strong>" + trail.name + "</strong><span>" + trail.description + "</span></span>" +
        "<span class='shop-state'>" + (equipped ? "ВЫБРАН" : owned ? "НАДЕТЬ" : "★ " + trail.price) + "</span>";
      list.appendChild(button);
    });
  }

  function trailPreviewMarkup(trail) {
    var effects = "";
    for (var i = 0; i < 4; i += 1) {
      var left = 5 + i * 11;
      var top = 25 + (i % 2) * 9;
      if (trail.asset) {
        effects += "<img src='assets/" + trail.asset + ".webp' alt='' style='position:absolute;width:" + (12 + i) + "px;left:" + left + "px;top:" + top + "px;opacity:" + (0.35 + i * 0.16) + "'>";
      } else {
        effects += "<i class='trail-dot' style='width:" + (5 + i) + "px;height:" + (5 + i) + "px;left:" + left + "px;top:" + top + "px;background:" + (i % 2 ? "#ffd814" : "#1fbfff") + ";opacity:" + (0.35 + i * 0.16) + "'></i>";
      }
    }
    if (trail.id === "cards") effects += "<i style='position:absolute;left:5px;right:24px;top:31px;height:10px;background:rgba(255,45,65,.55);filter:blur(6px)'></i>";
    return "<span class='shop-preview'>" + effects + "<img class='mini-bird' src='assets/bird.webp' alt=''></span>";
  }

  function handleTrail(trailId) {
    var trail = TRAILS.find(function (item) { return item.id === trailId; });
    if (!trail) return;
    var owned = profile.ownedTrails.indexOf(trailId) !== -1;
    if (!owned) {
      if (profile.wallet < trail.price) {
        showToast("Не хватает ещё " + formatNumber(trail.price - profile.wallet) + " очков");
        return;
      }
      profile.wallet -= trail.price;
      profile.ownedTrails.push(trailId);
      showToast("Шлейф куплен: " + trail.name);
    }
    profile.equippedTrail = trailId;
    saveProfile();
    renderShop();
    window.setTimeout(function () {
      var selected = document.querySelector("[data-trail='" + trailId + "']");
      if (selected) selected.focus();
    }, 20);
  }

  function showRanks() {
    renderRanks();
    navigateTo("ranks-screen");
  }

  function renderRanks() {
    var current = rankFor(profile.lifetimePipes);
    var list = document.getElementById("ranks-list");
    list.innerHTML = "";
    RANKS.forEach(function (rank, index) {
      var unlocked = profile.lifetimePipes >= rank.threshold;
      var row = document.createElement("div");
      row.className = "rank-row" + (unlocked ? " unlocked" : "") + (rank === current ? " current" : "");
      row.innerHTML =
        "<span class='rank-medal'>" + rank.medal + "</span>" +
        "<span class='rank-copy'><strong>" + rank.name + "</strong><span>" + (rank === current ? "Текущий ранг" : unlocked ? "Получен" : "Заблокирован") + "</span></span>" +
        "<span class='rank-needed'>" + (index === 0 ? "СТАРТ" : formatNumber(rank.threshold) + " труб") + "</span>";
      list.appendChild(row);
    });
  }

  function loadGameAssets() {
    if (assetsPromise) return assetsPromise;
    var names = ["background", "bird", "pipe", "reverse", "speed", "star", "planet", "card", "impact"];
    assetsPromise = Promise.all(names.map(function (name) {
      return new Promise(function (resolve) {
        var image = new Image();
        image.onload = function () { assets[name] = image; resolve(); };
        image.onerror = function () { resolve(); };
        image.src = name === "background" ? "assets/background.webp" : "assets/" + name + ".webp";
      });
    })).then(function () {
      buildCollisionMasks();
    });
    return assetsPromise;
  }

  function buildCollisionMasks() {
    if (!assets.bird || !assets.pipe) return;

    var birdWidth = BIRD_RENDER_WIDTH;
    var birdHeight = Math.round(birdWidth * (assets.bird.height / assets.bird.width));
    var birdCanvas = document.createElement("canvas");
    birdCanvas.width = birdWidth;
    birdCanvas.height = birdHeight;
    var birdContext = birdCanvas.getContext("2d", { willReadFrequently: true });
    birdContext.drawImage(assets.bird, 0, 0, birdWidth, birdHeight);
    var birdPixels = birdContext.getImageData(0, 0, birdWidth, birdHeight).data;
    var points = [];
    for (var y = 0; y < birdHeight; y += 1) {
      for (var x = 0; x < birdWidth; x += 1) {
        if (birdPixels[(y * birdWidth + x) * 4 + 3] >= COLLISION_ALPHA_THRESHOLD) {
          points.push({ x: x + 0.5 - birdWidth / 2, y: y + 0.5 - birdHeight / 2 });
        }
      }
    }
    collisionMasks.birdPoints = points;

    var pipeCanvas = document.createElement("canvas");
    pipeCanvas.width = assets.pipe.width;
    pipeCanvas.height = assets.pipe.height;
    var pipeContext = pipeCanvas.getContext("2d", { willReadFrequently: true });
    pipeContext.drawImage(assets.pipe, 0, 0);
    var pipePixels = pipeContext.getImageData(0, 0, pipeCanvas.width, pipeCanvas.height).data;
    var pipeAlpha = new Uint8Array(pipeCanvas.width * pipeCanvas.height);
    for (var pixel = 0; pixel < pipeAlpha.length; pixel += 1) pipeAlpha[pixel] = pipePixels[pixel * 4 + 3];
    collisionMasks.pipe = { alpha: pipeAlpha, width: pipeCanvas.width, height: pipeCanvas.height };
  }

  async function startGame() {
    navigateTo("game-screen");
    dom.startOverlay.classList.add("hidden");
    dom.gameOverOverlay.classList.add("hidden");
    drawLoadingFrame();
    await Promise.all([loadGameAssets(), audio.loadAssets()]);
    resetGame();
    dom.canvas.focus();
    launchRun();
  }

  function restartGame() {
    dom.gameOverOverlay.classList.add("hidden");
    resetGame();
    dom.canvas.focus();
    launchRun();
  }

  function resetGame() {
    stopGameLoop();
    clearPendingSensorGesture();
    hideVictoryOverlay();
    hideRankCelebration();
    game.status = "ready";
    game.bird = { x: BIRD_X, y: 292, vy: 0, rotation: 0 };
    game.pipes = [];
    game.particles = [];
    game.impact = null;
    var difficulty = activeDifficulty();
    game.lives = difficulty.lives;
    game.invulnerableUntil = 0;
    game.nextPipeNumber = 0;
    dom.difficultyHudLabel.textContent = difficulty.label + " • ЖИЗНИ";
    dom.livesHelp.innerHTML = "<b>" + difficulty.lives + " " + lifeWord(difficulty.lives).toUpperCase() + "</b> • сердце каждые 100 труб";
    game.score = 0;
    game.earned = 0;
    game.sector = 1;
    game.reverseUntil = 0;
    game.speedUntil = 0;
    game.lastTime = 0;
    game.lastTrailAt = 0;
    game.dyingAt = 0;
    game.rankCelebratingUntil = 0;
    game.pendingVictoryRank = null;
    spawnInitialPipes();
    updateHud(performance.now());
    drawGame(performance.now());
  }

  function launchRun() {
    if (game.status === "running") return;
    game.status = "running";
    game.lastTime = 0;
    game.bird.vy = -155;
    audio.startMusic();
    game.animationId = requestAnimationFrame(gameLoop);
  }

  function stopGameLoop() {
    if (game.animationId) cancelAnimationFrame(game.animationId);
    game.animationId = 0;
    game.lastTime = 0;
  }

  function spawnInitialPipes() {
    var x = 670;
    for (var i = 0; i < 4; i += 1) {
      spawnPipe(x);
      x += pipeSpacing();
    }
  }

  function spawnPipe(x) {
    if (game.nextPipeNumber >= TOTAL_PIPES) return;
    game.nextPipeNumber += 1;
    var pipeNumber = game.nextPipeNumber;
    var gap = pipeGap();
    var minCenter = 120 + gap / 2;
    var maxCenter = 515 - gap / 2;
    var center = minCenter + Math.random() * (maxCenter - minCenter);
    var modifier = null;
    var chance = Math.min(activeDifficulty().id === "hard" ? 0.32 : 0.22, (0.08 + Math.max(0, game.sector - 1) * 0.012) * activeDifficulty().modifierChance);
    if (game.score >= 7 && Math.random() < chance) {
      var type = Math.random() < 0.55 ? "reverse" : "speed";
      var side = Math.random() < 0.5 ? -1 : 1;
      modifier = {
        type: type,
        x: x + PIPE_WIDTH / 2,
        y: center + side * (gap / 2 - 29),
        radius: 21,
        collected: false
      };
    }
    var heart = null;
    if (pipeNumber % HEART_PIPE_INTERVAL === 0) {
      var heartSide = Math.floor(pipeNumber / HEART_PIPE_INTERVAL) % 2 ? 1 : -1;
      if (modifier) heartSide = modifier.y < center ? 1 : -1;
      heart = {
        x: x + PIPE_WIDTH / 2,
        y: center + heartSide * Math.min(38, gap / 2 - 42),
        radius: 15,
        collected: false
      };
    }
    game.pipes.push({ number: pipeNumber, x: x, gapY: center - gap / 2, gapH: gap, passed: false, modifier: modifier, heart: heart });
  }

  function pipeGap() {
    var difficulty = Math.min(12, Math.max(0, game.sector - 1));
    var mode = activeDifficulty();
    return mode.gapBase - difficulty * mode.gapShrink;
  }

  function pipeSpacing() {
    var difficulty = Math.min(12, Math.max(0, game.sector - 1));
    var mode = activeDifficulty();
    return mode.spacingBase - difficulty * mode.spacingShrink;
  }

  function worldSpeed(now) {
    var difficulty = Math.min(12, Math.max(0, game.sector - 1));
    var mode = activeDifficulty();
    return mode.speedBase + difficulty * mode.speedGrowth + (now < game.speedUntil ? 48 : 0);
  }

  function gameLoop(timestamp) {
    if (currentScreen !== "game-screen") return;
    if (!game.lastTime) game.lastTime = timestamp;
    var dt = Math.min(0.035, (timestamp - game.lastTime) / 1000);
    game.lastTime = timestamp;
    updateGame(dt, timestamp);
    drawGame(timestamp);
    updateHud(timestamp);
    if (game.status === "running" || game.status === "dying") game.animationId = requestAnimationFrame(gameLoop);
  }

  function updateGame(dt, now) {
    if (game.status === "running") {
      var reachedFinish = false;
      game.bird.vy = Math.min(470, game.bird.vy + 760 * dt);
      game.bird.y += game.bird.vy * dt;
      game.bird.rotation = clamp(game.bird.vy / 650, -0.42, 0.78);
      var speed = worldSpeed(now);
      for (var i = 0; i < game.pipes.length; i += 1) {
        var pipe = game.pipes[i];
        pipe.x -= speed * dt;
        if (pipe.modifier) pipe.modifier.x = pipe.x + PIPE_WIDTH / 2;
        if (pipe.heart) pipe.heart.x = pipe.x + PIPE_WIDTH / 2;
        if (!pipe.passed && pipe.x + PIPE_WIDTH < game.bird.x - 19) {
          pipe.passed = true;
          game.score += 1;
          game.earned += 1;
          game.sector = Math.min(10, Math.floor(game.score / 100) + 1);
          audio.point();
          if (game.score >= TOTAL_PIPES) {
            reachedFinish = true;
            break;
          }
        }
        if (pipe.modifier && !pipe.modifier.collected && circleBirdCollision(pipe.modifier)) collectModifier(pipe.modifier, now);
        if (pipe.heart && !pipe.heart.collected && circleBirdCollision(pipe.heart)) collectHeart(pipe.heart);
      }
      if (reachedFinish) {
        finishVictory();
        return;
      }
      while (game.pipes.length && game.pipes[0].x + PIPE_WIDTH < -30) game.pipes.shift();
      if (game.nextPipeNumber < TOTAL_PIPES && game.pipes.length && game.pipes[game.pipes.length - 1].x < GAME_WIDTH - pipeSpacing()) {
        spawnPipe(game.pipes[game.pipes.length - 1].x + pipeSpacing());
      }
      spawnTrail(now);
      if (now >= game.invulnerableUntil && birdHitsWorld()) handleBirdHit(now);
    } else if (game.status === "dying") {
      game.bird.vy += 1020 * dt;
      game.bird.y += game.bird.vy * dt;
      game.bird.rotation = Math.min(1.72, game.bird.rotation + 2.8 * dt);
      if (game.bird.y > 690 || now - game.dyingAt > 1180) finishRun();
    }

    updateParticles(dt);
    if (game.impact) {
      game.impact.age += dt;
      if (game.impact.age > 0.5) game.impact = null;
    }
  }

  function applyUpCommand() {
    if (game.status !== "running") return;
    if (performance.now() < game.reverseUntil) dive();
    else flap();
  }

  function applyDownCommand() {
    if (game.status !== "running") return;
    if (performance.now() < game.reverseUntil) flap();
    else dive();
  }

  function flap() {
    game.bird.vy = -258;
    game.bird.rotation = -0.34;
    audio.flap();
  }

  function dive() {
    game.bird.vy = Math.max(game.bird.vy, 278);
    game.bird.rotation = 0.48;
    audio.dive();
  }

  function birdHitsWorld() {
    if (!collisionMasks.birdPoints.length || !collisionMasks.pipe) return false;
    var cosine = Math.cos(game.bird.rotation);
    var sine = Math.sin(game.bird.rotation);
    var nearbyPipes = game.pipes.filter(function (pipe) {
      return pipe.x < game.bird.x + 44 && pipe.x + PIPE_WIDTH > game.bird.x - 44;
    });

    for (var pointIndex = 0; pointIndex < collisionMasks.birdPoints.length; pointIndex += 1) {
      var point = collisionMasks.birdPoints[pointIndex];
      var worldX = game.bird.x + cosine * point.x - sine * point.y;
      var worldY = game.bird.y + sine * point.x + cosine * point.y;
      if (worldY < 0 || worldY > PLAY_FLOOR) return true;
      for (var pipeIndex = 0; pipeIndex < nearbyPipes.length; pipeIndex += 1) {
        if (pipePixelIsSolid(nearbyPipes[pipeIndex], worldX, worldY)) return true;
      }
    }
    return false;
  }

  function pipePixelIsSolid(pipe, worldX, worldY) {
    var mask = collisionMasks.pipe;
    var normalizedX = (worldX - pipe.x) / PIPE_WIDTH;
    if (normalizedX < 0 || normalizedX >= 1) return false;

    var sourceY = -1;
    var topHeight = Math.max(40, pipe.gapY);
    var bottomY = pipe.gapY + pipe.gapH;
    var bottomHeight = GAME_HEIGHT - bottomY + 18;
    if (worldY >= 0 && worldY < topHeight) {
      sourceY = (1 - worldY / topHeight) * mask.height;
    } else if (worldY >= bottomY && worldY < bottomY + bottomHeight) {
      sourceY = ((worldY - bottomY) / bottomHeight) * mask.height;
    }
    if (sourceY < 0 || sourceY >= mask.height) return false;

    var sourceX = Math.min(mask.width - 1, Math.max(0, Math.floor(normalizedX * mask.width)));
    var sourceYIndex = Math.min(mask.height - 1, Math.max(0, Math.floor(sourceY)));
    return mask.alpha[sourceYIndex * mask.width + sourceX] >= COLLISION_ALPHA_THRESHOLD;
  }

  function circleBirdCollision(modifier) {
    var dx = game.bird.x - modifier.x;
    var dy = game.bird.y - modifier.y;
    return dx * dx + dy * dy < (modifier.radius + 20) * (modifier.radius + 20);
  }

  function collectModifier(modifier, now) {
    modifier.collected = true;
    if (modifier.type === "reverse") game.reverseUntil = now + 5000;
    if (modifier.type === "speed") game.speedUntil = now + 5000;
    audio.modifier();
    for (var i = 0; i < 10; i += 1) addBurstParticle(modifier.x, modifier.y, modifier.type === "reverse" ? "#b778ff" : "#ffe82c");
  }

  function collectHeart(heart) {
    heart.collected = true;
    game.lives += 1;
    audio.heart();
    animateLives("life-gained");
    for (var i = 0; i < 14; i += 1) addBurstParticle(heart.x, heart.y, i % 2 ? "#ff4c78" : "#fff0a6");
  }

  function handleBirdHit(now) {
    game.lives = Math.max(0, game.lives - 1);
    animateLives("life-lost");
    if (game.lives <= 0) {
      beginDeath(now);
      return;
    }

    game.invulnerableUntil = now + HIT_GRACE_MS;
    game.bird.y = clamp(game.bird.y, 44, PLAY_FLOOR - 44);
    game.bird.vy = game.bird.y > GAME_HEIGHT / 2 ? -235 : 190;
    game.impact = { x: game.bird.x + 17, y: game.bird.y, age: 0 };
    audio.lifeLost();
    for (var i = 0; i < 12; i += 1) addBurstParticle(game.bird.x, game.bird.y, i % 2 ? "#ff4c78" : "#7be9ff");
  }

  function animateLives(className) {
    if (!dom.livesBlock) return;
    dom.livesBlock.classList.remove("life-gained", "life-lost");
    void dom.livesBlock.offsetWidth;
    dom.livesBlock.classList.add(className);
    window.setTimeout(function () { dom.livesBlock.classList.remove(className); }, 440);
  }

  function beginDeath(now) {
    if (game.status !== "running") return;
    game.status = "dying";
    game.dyingAt = now;
    game.bird.vy = -105;
    game.impact = { x: game.bird.x + 17, y: game.bird.y, age: 0 };
    audio.collision();
    for (var i = 0; i < 22; i += 1) addBurstParticle(game.bird.x, game.bird.y, i % 3 === 0 ? "#ff426d" : i % 2 ? "#50e6ff" : "#ffd814");
  }

  function finishRun() {
    if (game.status === "over") return;
    game.status = "over";
    stopGameLoop();
    var oldRank = rankFor(profile.lifetimePipes);
    profile.wallet += game.earned;
    profile.lifetimePipes += game.score;
    profile.scores.push({ score: game.score, timestamp: Date.now(), sector: game.sector, difficulty: activeDifficulty().id });
    profile.scores = profile.scores.sort(function (a, b) { return b.score - a.score || b.timestamp - a.timestamp; }).slice(0, 50);
    var newRank = rankFor(profile.lifetimePipes);
    saveProfile();
    var best = profile.scores.length ? profile.scores[0].score : game.score;
    document.getElementById("final-score").textContent = formatNumber(game.score);
    document.getElementById("final-best").textContent = formatNumber(best);
    document.getElementById("final-earned").textContent = "+" + formatNumber(game.earned);
    var unlock = document.getElementById("rank-unlock");
    if (newRank !== oldRank) {
      unlock.textContent = "НОВЫЙ РАНГ: " + newRank.name;
      unlock.classList.remove("hidden");
    } else {
      unlock.classList.add("hidden");
    }
    dom.gameOverOverlay.classList.remove("hidden");
    if (newRank !== oldRank) showRankCelebration(newRank);
    window.setTimeout(function () {
      var button = dom.gameOverOverlay.querySelector("[data-action='restart-game']");
      if (button) button.focus();
    }, 50);
  }

  function finishVictory() {
    if (game.status === "victory") return;
    game.status = "victory";
    game.score = TOTAL_PIPES;
    game.earned = Math.max(game.earned, TOTAL_PIPES);
    game.sector = 10;
    stopGameLoop();
    updateHud(performance.now());

    var oldRank = rankFor(profile.lifetimePipes);
    profile.wallet += game.earned;
    profile.lifetimePipes += game.score;
    profile.scores.push({
      score: game.score,
      timestamp: Date.now(),
      sector: 10,
      difficulty: activeDifficulty().id,
      victory: true
    });
    profile.scores = profile.scores.sort(function (a, b) { return b.score - a.score || b.timestamp - a.timestamp; }).slice(0, 50);
    profile.hasWon = true;
    profile.wins = (Number(profile.wins) || 0) + 1;
    var newRank = rankFor(profile.lifetimePipes);
    saveProfile();

    showVictoryOverlay(newRank !== oldRank ? newRank : null);
  }

  function showVictoryOverlay(unlockedRank) {
    window.clearTimeout(victoryRevealTimer);
    hideRankCelebration();
    dom.gameOverOverlay.classList.add("hidden");
    game.pendingVictoryRank = unlockedRank || null;
    dom.victoryOverlay.classList.remove("hidden", "active", "final-state");
    dom.victoryOverlay.classList.add("video-playing");
    void dom.victoryOverlay.offsetWidth;
    dom.victoryOverlay.classList.add("active");
    try {
      dom.victoryVideo.currentTime = 0;
      dom.victoryVideo.muted = true;
      var playback = dom.victoryVideo.play();
      if (playback && typeof playback.catch === "function") playback.catch(revealVictoryFinal);
    } catch (error) {
      revealVictoryFinal();
    }
    audio.victory();
    victoryRevealTimer = window.setTimeout(revealVictoryFinal, 10250);
  }

  function revealVictoryFinal() {
    if (!dom.victoryOverlay || dom.victoryOverlay.classList.contains("hidden")) return;
    window.clearTimeout(victoryRevealTimer);
    victoryRevealTimer = 0;
    try { dom.victoryVideo.pause(); } catch (error) {}
    dom.victoryOverlay.classList.remove("video-playing", "active");
    dom.victoryOverlay.classList.add("final-state");
    void dom.victoryOverlay.offsetWidth;
    dom.victoryOverlay.classList.add("active");
    window.setTimeout(function () {
      if (game.status !== "victory" || !game.pendingVictoryRank) return;
      var rank = game.pendingVictoryRank;
      game.pendingVictoryRank = null;
      showRankCelebration(rank);
    }, 2600);
    window.setTimeout(function () {
      if (game.status !== "victory") return;
      var button = dom.victoryOverlay.querySelector("[data-action='restart-game']");
      if (button) button.focus();
    }, 2250);
  }

  function hideVictoryOverlay() {
    window.clearTimeout(victoryRevealTimer);
    victoryRevealTimer = 0;
    if (!dom.victoryOverlay || !dom.victoryVideo) return;
    try {
      dom.victoryVideo.pause();
      dom.victoryVideo.currentTime = 0;
    } catch (error) {}
    dom.victoryOverlay.classList.add("hidden");
    dom.victoryOverlay.classList.remove("active", "video-playing", "final-state");
    game.pendingVictoryRank = null;
  }

  function showRankCelebration(rank) {
    if (!dom.rankCelebration) return;
    dom.rankCelebrationMedal.textContent = rank.medal || "★";
    dom.rankCelebrationName.textContent = rank.name;
    dom.rankCelebration.classList.remove("hidden", "active");
    void dom.rankCelebration.offsetWidth;
    dom.rankCelebration.classList.add("active");
    game.rankCelebratingUntil = performance.now() + 3750;
    audio.rankUp();
    window.setTimeout(function () {
      if (performance.now() >= game.rankCelebratingUntil - 30) hideRankCelebration();
    }, 3790);
  }

  function hideRankCelebration() {
    if (!dom.rankCelebration) return;
    dom.rankCelebration.classList.add("hidden");
    dom.rankCelebration.classList.remove("active");
  }

  function spawnTrail(now) {
    if (now - game.lastTrailAt < 54) return;
    game.lastTrailAt = now;
    var trail = profile.equippedTrail;
    var particle = {
      x: game.bird.x - 31,
      y: game.bird.y + (Math.random() - 0.5) * 15,
      vx: -54 - Math.random() * 50,
      vy: (Math.random() - 0.5) * 26,
      life: 0.82 + Math.random() * 0.35,
      age: 0,
      size: 6 + Math.random() * 8,
      trail: trail,
      spin: (Math.random() - 0.5) * 3,
      rotation: Math.random() * Math.PI * 2
    };
    game.particles.push(particle);
    if (game.particles.length > 110) game.particles.splice(0, game.particles.length - 110);
  }

  function addBurstParticle(x, y, color) {
    var angle = Math.random() * Math.PI * 2;
    var force = 45 + Math.random() * 125;
    game.particles.push({
      x: x,
      y: y,
      vx: Math.cos(angle) * force,
      vy: Math.sin(angle) * force,
      life: 0.4 + Math.random() * 0.42,
      age: 0,
      size: 4 + Math.random() * 7,
      trail: "burst",
      color: color,
      spin: 0,
      rotation: 0
    });
  }

  function updateParticles(dt) {
    for (var i = game.particles.length - 1; i >= 0; i -= 1) {
      var p = game.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        game.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
    }
  }

  function drawLoadingFrame() {
    var ctx = dom.ctx;
    ctx.fillStyle = "#031934";
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.fillStyle = "#ffd814";
    ctx.font = "900 30px Arial";
    ctx.textAlign = "center";
    ctx.fillText("ГОТОВИМ НЕБО…", 300, 306);
  }

  function drawGame(now) {
    var ctx = dom.ctx;
    if (assets.background) ctx.drawImage(assets.background, 0, 0, GAME_WIDTH, GAME_HEIGHT);
    else {
      ctx.fillStyle = "#031934";
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
    ctx.fillStyle = "rgba(0, 15, 48, 0.06)";
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    drawParticles(ctx);
    drawPipes(ctx, now);
    drawModifiers(ctx, now);
    drawHearts(ctx, now);
    drawBird(ctx);
    drawLifeShield(ctx, now);
    drawImpact(ctx);
  }

  function drawPipes(ctx) {
    if (!assets.pipe) return;
    var hue = ((game.sector - 1) * 28) % 180;
    var brightness = Math.max(0.46, 1 - (game.sector - 1) * 0.045);
    ctx.save();
    ctx.filter = "hue-rotate(" + hue + "deg) brightness(" + brightness + ") saturate(1.08)";
    for (var i = 0; i < game.pipes.length; i += 1) {
      var pipe = game.pipes[i];
      var topHeight = Math.max(40, pipe.gapY);
      var bottomY = pipe.gapY + pipe.gapH;
      var bottomHeight = GAME_HEIGHT - bottomY + 18;
      ctx.save();
      ctx.translate(pipe.x + PIPE_WIDTH / 2, topHeight / 2);
      ctx.scale(1, -1);
      ctx.drawImage(assets.pipe, -PIPE_WIDTH / 2, -topHeight / 2, PIPE_WIDTH, topHeight);
      ctx.restore();
      ctx.drawImage(assets.pipe, pipe.x, bottomY, PIPE_WIDTH, bottomHeight);
    }
    ctx.restore();
  }

  function drawModifiers(ctx, now) {
    for (var i = 0; i < game.pipes.length; i += 1) {
      var mod = game.pipes[i].modifier;
      if (!mod || mod.collected || !assets[mod.type]) continue;
      var pulse = 1 + Math.sin(now / 150) * 0.08;
      var size = 46 * pulse;
      ctx.save();
      ctx.globalAlpha = 0.96;
      ctx.shadowBlur = 14;
      ctx.shadowColor = mod.type === "reverse" ? "#9f63ff" : "#ffe72b";
      ctx.drawImage(assets[mod.type], mod.x - size / 2, mod.y - size / 2, size, size);
      ctx.restore();
    }
  }

  function drawHearts(ctx, now) {
    for (var i = 0; i < game.pipes.length; i += 1) {
      var heart = game.pipes[i].heart;
      if (!heart || heart.collected) continue;
      var pulse = 1 + Math.sin(now / 135 + i) * 0.09;
      ctx.save();
      ctx.translate(heart.x, heart.y);
      ctx.scale(pulse, pulse);
      ctx.shadowBlur = 17;
      ctx.shadowColor = "#ff3769";
      ctx.fillStyle = "#ff426d";
      ctx.strokeStyle = "#fff4d1";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, 13);
      ctx.bezierCurveTo(-4, 8, -15, 1, -15, -7);
      ctx.bezierCurveTo(-15, -17, -3, -20, 0, -11);
      ctx.bezierCurveTo(3, -20, 15, -17, 15, -7);
      ctx.bezierCurveTo(15, 1, 4, 8, 0, 13);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.beginPath();
      ctx.arc(-6, -9, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawLifeShield(ctx, now) {
    if (now >= game.invulnerableUntil || game.status !== "running") return;
    var remaining = (game.invulnerableUntil - now) / HIT_GRACE_MS;
    var pulse = 1 + Math.sin(now / 70) * 0.07;
    ctx.save();
    ctx.translate(game.bird.x, game.bird.y);
    ctx.scale(pulse, pulse);
    ctx.globalAlpha = 0.3 + remaining * 0.45;
    ctx.strokeStyle = "#78ecff";
    ctx.lineWidth = 4;
    ctx.shadowBlur = 18;
    ctx.shadowColor = "#42d9ff";
    ctx.beginPath();
    ctx.arc(0, 0, 45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles(ctx) {
    for (var i = 0; i < game.particles.length; i += 1) {
      var p = game.particles[i];
      var alpha = 1 - p.age / p.life;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      var image = null;
      if (p.trail === "gold") image = assets.star;
      if (p.trail === "galaxy") image = assets.planet;
      if (p.trail === "cards") image = assets.card;
      if (image) {
        if (p.trail === "cards") {
          ctx.shadowBlur = 16;
          ctx.shadowColor = "#ff304b";
        }
        ctx.drawImage(image, -p.size, -p.size, p.size * 2, p.size * 2);
      } else {
        ctx.fillStyle = p.color || (i % 2 ? "#ffd814" : "#1fbfff");
        ctx.shadowBlur = 10;
        ctx.shadowColor = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(0, 0, p.size * 0.56, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawBird(ctx) {
    if (!assets.bird) return;
    var width = BIRD_RENDER_WIDTH;
    var height = width * (assets.bird.height / assets.bird.width);
    ctx.save();
    ctx.translate(game.bird.x, game.bird.y);
    ctx.rotate(game.bird.rotation);
    if (game.status === "dying") ctx.globalAlpha = Math.max(0.55, 1 - (performance.now() - game.dyingAt) / 1800);
    ctx.shadowBlur = 13;
    ctx.shadowColor = "rgba(0,16,55,.65)";
    ctx.drawImage(assets.bird, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  function drawImpact(ctx) {
    if (!game.impact || !assets.impact) return;
    var progress = game.impact.age / 0.5;
    var size = 54 + progress * 56;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(assets.impact, game.impact.x - size / 2, game.impact.y - size / 2, size, size);
    ctx.restore();
  }

  function updateHud(now) {
    dom.scoreValue.textContent = String(game.score).padStart(3, "0");
    dom.runWallet.textContent = formatNumber(game.earned);
    dom.goalProgress.textContent = Math.min(game.score, TOTAL_PIPES) + "/" + TOTAL_PIPES;
    renderLives();
    dom.sectorLabel.textContent = "СЕКТОР " + game.sector;
    var within = game.score >= TOTAL_PIPES ? 100 : game.score % 100;
    dom.sectorProgress.textContent = within + "/100";
    dom.sectorFill.style.width = within + "%";
    var remaining = 0;
    var type = "";
    if (now < game.reverseUntil) {
      remaining = game.reverseUntil - now;
      type = "РЕВЕРС";
    } else if (now < game.speedUntil) {
      remaining = game.speedUntil - now;
      type = "УСКОРЕНИЕ";
    }
    if (remaining > 0) {
      dom.modifierBadge.textContent = type + " " + Math.ceil(remaining / 1000) + "с";
      dom.modifierBadge.classList.remove("hidden");
    } else {
      dom.modifierBadge.classList.add("hidden");
    }
  }

  function renderLives() {
    if (!dom.livesValue) return;
    var markup = "";
    if (game.lives <= 5) {
      for (var i = 0; i < game.lives; i += 1) markup += '<i class="life-heart">♥</i>';
    } else {
      markup = '<i class="life-heart">♥</i><b class="life-count">×' + game.lives + "</b>";
    }
    dom.livesValue.innerHTML = markup;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.remove("hidden");
    var words = message.trim().split(/\s+/).length;
    var duration = Math.min(8000, 3500 + Math.max(0, words - 2) * 300);
    toastTimer = window.setTimeout(function () { dom.toast.classList.add("hidden"); }, duration);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ru-RU").format(value);
  }

  function activeDifficulty() {
    return DIFFICULTIES[profile && profile.difficulty] || DIFFICULTIES.medium;
  }

  function lifeWord(value) {
    var mod100 = Math.abs(value) % 100;
    var mod10 = mod100 % 10;
    if (mod100 > 10 && mod100 < 20) return "жизней";
    if (mod10 === 1) return "жизнь";
    if (mod10 > 1 && mod10 < 5) return "жизни";
    return "жизней";
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(timestamp));
  }

  function pipeWord(value) {
    var mod100 = Math.abs(value) % 100;
    var mod10 = mod100 % 10;
    if (mod100 > 10 && mod100 < 20) return "труб";
    if (mod10 === 1) return "труба";
    if (mod10 > 1 && mod10 < 5) return "трубы";
    return "труб";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
})();
