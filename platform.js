/* =========================================================================
   AURA / ElevatED U — shared platform layer (multi-user, persistence, realtime)
   Requires supabase-js UMD loaded first (window.supabase).
   Local-first friendly: every call no-ops safely when signed out or offline.
   Backend: Supabase project "elevated-u-prototype" (yqzokkqwhndtqqjiwomi).
   The anon/publishable key below is PUBLIC-safe (RLS enforces per-user access).
   ========================================================================= */
(function () {
  var SUPA_URL = "https://yqzokkqwhndtqqjiwomi.supabase.co";
  var SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlxem9ra3F3aG5kdHFxaml3b21pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzI2NTcsImV4cCI6MjA5Njk0ODY1N30.3rdfRSaXMVcPuyccNHOtH0pgmNAKH_iG4ykKm1TNcCM";

  var P = {
    client: null, _user: null, _profile: null, _cbs: [], ready: false,
    available: function () { return !!this.client; },
    user: function () { return this._user; },
    profile: function () { return this._profile; },
    onAuth: function (cb) { this._cbs.push(cb); if (this.ready) cb(this._user); }
  };

  function emit() { P._cbs.forEach(function (cb) { try { cb(P._user); } catch (e) {} }); }

  if (!(window.supabase && window.supabase.createClient)) {
    // supabase-js failed to load (offline / CDN blocked) — expose a stub so pages still run locally.
    window.AURA_PLATFORM = P; P.ready = true; emit(); return;
  }

  P.client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "aura-auth" }
  });

  // ---- profile bootstrap ----
  function loadProfile() {
    if (!P._user) { P._profile = null; return Promise.resolve(); }
    return P.client.from("tp_profiles").select("*").eq("user_id", P._user.id).maybeSingle()
      .then(function (r) { P._profile = r.data || null; })
      .catch(function () {});
  }
  function ensureProfile(displayName) {
    if (!P._user) return Promise.resolve();
    return P.client.from("tp_profiles").upsert(
      { user_id: P._user.id, display_name: displayName || (P._user.email || "Student").split("@")[0], consent_at: new Date().toISOString() },
      { onConflict: "user_id" }
    ).then(loadProfile).catch(function () {});
  }

  // ---- auth API ----
  P.signUp = function (email, pw, displayName) {
    return P.client.auth.signUp({ email: email, password: pw, options: { data: { display_name: displayName } } })
      .then(function (r) {
        if (r.error) throw r.error;
        // If email confirmation is off, session exists now → create profile.
        if (r.data && r.data.session) { P._user = r.data.user; return ensureProfile(displayName).then(function () { emit(); return r; }); }
        return r; // needs email confirmation
      });
  };
  P.signIn = function (email, pw) {
    return P.client.auth.signInWithPassword({ email: email, password: pw })
      .then(function (r) { if (r.error) throw r.error; return r; });
  };
  P.signOut = function () { return P.client.auth.signOut().then(function () { P._user = null; P._profile = null; emit(); }); };

  P.client.auth.getSession().then(function (r) {
    P._user = (r.data && r.data.session && r.data.session.user) || null;
    return loadProfile();
  }).then(function () { P.ready = true; emit(); });

  P.client.auth.onAuthStateChange(function (_evt, session) {
    P._user = (session && session.user) || null;
    loadProfile().then(function () {
      if (P._user && !P._profile) ensureProfile((P._user.user_metadata && P._user.user_metadata.display_name));
      emit();
    });
  });

  // ---- persistence (fire-and-forget; safe when signed out) ----
  P.logEvent = function (evt) {
    if (!P._user) return Promise.resolve();
    var row = Object.assign({ user_id: P._user.id, created_at: new Date().toISOString() }, evt);
    return P.client.from("tp_events").insert(row).then(function () {}).catch(function () {});
  };
  // rolling vulnerability counters — one row per (dimension,key)
  P.bumpDNA = function (dimension, key, correct) {
    if (!P._user || !key) return Promise.resolve();
    var uid = P._user.id;
    return P.client.from("tp_error_dna").select("attempts,misses").eq("user_id", uid).eq("dimension", dimension).eq("key", key).maybeSingle()
      .then(function (r) {
        var a = (r.data && r.data.attempts) || 0, m = (r.data && r.data.misses) || 0;
        return P.client.from("tp_error_dna").upsert(
          { user_id: uid, dimension: dimension, key: key, attempts: a + 1, misses: m + (correct ? 0 : 1), updated_at: new Date().toISOString() },
          { onConflict: "user_id,dimension,key" }
        );
      }).then(function () {}).catch(function () {});
  };
  P.myDNA = function () {
    if (!P._user) return Promise.resolve([]);
    return P.client.from("tp_error_dna").select("*").eq("user_id", P._user.id)
      .then(function (r) { return r.data || []; }).catch(function () { return []; });
  };

  // ---- realtime "sprint room" (live multi-user simulation) ----
  // Presence + broadcast: students join a room code; host/teacher sees live progress.
  P.joinRoom = function (code, opts) {
    opts = opts || {};
    var ch = P.client.channel("room:" + code, { config: { presence: { key: (P._user && P._user.id) || ("guest-" + Math.random().toString(36).slice(2)) } } });
    var api = {
      channel: ch,
      publish: function (payload) { return ch.send({ type: "broadcast", event: "progress", payload: payload }); },
      track: function (meta) { return ch.track(meta || {}); }
    };
    ch.on("broadcast", { event: "progress" }, function (m) { if (opts.onProgress) opts.onProgress(m.payload); });
    ch.on("presence", { event: "sync" }, function () { if (opts.onPresence) opts.onPresence(ch.presenceState()); });
    ch.subscribe(function (status) { if (status === "SUBSCRIBED" && opts.onReady) opts.onReady(api); });
    return api;
  };

  window.AURA_PLATFORM = P;
})();
