/* PlayCanvas legacy script: attach to an NPC entity; set Backend URL in Inspector. */
var NpcGeminiVoice = pc.createScript('npcGeminiVoice');
NpcGeminiVoice.attributes.add('backendUrl', { type: 'string', title: 'Railway URL', default: 'https://YOUR-SERVICE.up.railway.app' });
NpcGeminiVoice.attributes.add('npcId', { type: 'string', title: 'NPC ID', default: 'dante' });
NpcGeminiVoice.attributes.add('cameraEntity', { type: 'entity', title: 'Player Camera' });
NpcGeminiVoice.attributes.add('interactionDistance', { type: 'number', default: 4, min: 1, max: 20 });

NpcGeminiVoice.prototype.initialize = function () {
    var self = this;
    this.ws = null;
    this.started = false;
    this.connecting = false;
    this.mic = null;
    this.context = null;
    this.microphoneNode = null;
    this.micSource = null;
    this.outVolume = null;
    this.nextAudioAt = 0;
    this.playing = [];
    this.waitingReset = false;
    this.playerId = this._loadPlayerId();

    this.panel = document.createElement('div');
    this.panel.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:min(390px,92vw);background:rgba(5,13,23,.93);color:#e8faff;border:1px solid #19c7ea;padding:15px;border-radius:12px;font:14px system-ui;z-index:10000;box-shadow:0 0 20px #0bf2;display:none';
    this.panel.innerHTML = '<div style="font-size:16px;font-weight:700;margin-bottom:5px">NPC: '+this._escape(this.npcId)+'</div>' +
        '<div class="npc-status" style="min-height:20px;color:#a4c8d7">Acercate y pulsá E para hablar</div>' +
        '<div class="npc-transcript" style="margin:8px 0;min-height:32px;max-height:90px;overflow:auto"></div>' +
        '<div style="display:flex;gap:7px;flex-wrap:wrap">' +
        '<button class="npc-start" style="padding:10px;cursor:pointer">🎙 Hablar</button>' +
        '<button class="npc-stop" style="padding:10px;cursor:pointer">Terminar</button>' +
        '<button class="npc-reset" style="padding:10px;cursor:pointer">↻ Restablecer NPC</button></div>';
    document.body.appendChild(this.panel);
    this.statusEl = this.panel.querySelector('.npc-status');
    this.transcriptEl = this.panel.querySelector('.npc-transcript');
    this.panel.querySelector('.npc-start').onclick = function () { self.begin(); };
    this.panel.querySelector('.npc-stop').onclick = function () { self.end(); };
    this.panel.querySelector('.npc-reset').onclick = function () {
        if (confirm('¿Querés restablecer los recuerdos de este NPC? Su personalidad seguirá igual.')) self.reset();
    };
    this.on('destroy', this._onDestroy, this);
};

NpcGeminiVoice.prototype._loadPlayerId = function () {
    try {
        var id = localStorage.getItem('umbral_player_id');
        if (id && /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 64) return id;
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        id = 'player_' + Array.from(bytes).map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
        localStorage.setItem('umbral_player_id', id);
        return id;
    } catch (e) { return 'local_' + Math.random().toString(36).slice(2); }
};

NpcGeminiVoice.prototype._escape = function (str) {
    return String(str).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]; });
};
NpcGeminiVoice.prototype._status = function (s) { if (this.statusEl) this.statusEl.textContent = s; };
NpcGeminiVoice.prototype.update = function () {
    var cam = this.cameraEntity || this.app.root.findByName('Camera');
    if (!cam) return;
    var distance = cam.getPosition().distance(this.entity.getPosition());
    var close = distance <= this.interactionDistance;
    this.panel.style.display = (close || this.started || this.connecting) ? 'block' : 'none';
    if (close && this.app.keyboard && this.app.keyboard.wasPressed(pc.KEY_E) && !this.started && !this.connecting) this.begin();
};

NpcGeminiVoice.prototype._ticket = async function () {
    var backend = this.backendUrl.replace(/\/+$/, '');
    if (!backend.startsWith('https://') && !backend.startsWith('http://localhost')) throw new Error('Usá la URL HTTPS de Railway');
    var response = await fetch(backend + '/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ npcId: this.npcId, playerId: this.playerId })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error creando sesión');
    return { backend: backend, token: data.token };
};

NpcGeminiVoice.prototype.begin = async function () {
    if (this.started || this.connecting) return;
    this.connecting = true;
    this._status('Conectando con Gemini...');
    try {
        if (!window.isSecureContext) throw new Error('El micrófono necesita HTTPS');
        var ticket = await this._ticket();
        this.context = this.context || new (window.AudioContext || window.webkitAudioContext)();
        await this.context.resume();
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        var url = ticket.backend.replace(/^http/, 'ws') + '/live?token=' + encodeURIComponent(ticket.token);
        var self = this;
        this.ws = new WebSocket(url);
        this.ws.onopen = function () { self._status('Conectando al personaje...'); };
        this.ws.onmessage = function (event) { self._handle(JSON.parse(event.data)); };
        this.ws.onerror = function () { self._status('Falló la conexión. Revisá Railway.'); };
        this.ws.onclose = function () { self._stopMic(); self.started = false; self.connecting = false; };
    } catch (e) {
        this.connecting = false;
        this._stopMic();
        this._status('Error: ' + e.message);
    }
};

NpcGeminiVoice.prototype._handle = function (msg) {
    if (msg.type === 'ready') {
        if (this.waitingReset) { this.ws.send(JSON.stringify({ type: 'reset' })); return; }
        if (!this.started) {
            this.started = true;
            this.connecting = false;
            this._startMic();
        }
        this._status('🎙 Te escucha. Podés hablar.');
    } else if (msg.type === 'audio') {
        this._playPcm(msg.data, msg.rate || 24000);
    } else if (msg.type === 'interrupted') {
        this._stopPlayback();
    } else if (msg.type === 'transcript') {
        var line = document.createElement('div');
        line.textContent = (msg.role === 'user' ? 'Vos: ' : 'NPC: ') + msg.text;
        this.transcriptEl.appendChild(line);
        while (this.transcriptEl.childNodes.length > 12) this.transcriptEl.removeChild(this.transcriptEl.firstChild);
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    } else if (msg.type === 'reset_ok') {
        this.waitingReset = false;
        this._status('✓ NPC restablecido. Podés conocerlo otra vez.');
        this.transcriptEl.replaceChildren();
        this.end();
    } else if (msg.type === 'error') {
        this._status('Error: ' + msg.message);
    }
};

NpcGeminiVoice.prototype._startMic = function () {
    if (!this.mic || this.microphoneNode) return;
    var self = this;
    this.micSource = this.context.createMediaStreamSource(this.mic);
    this.microphoneNode = this.context.createScriptProcessor(4096, 1, 1);
    this.microphoneNode.onaudioprocess = function (event) {
        if (!self.ws || self.ws.readyState !== WebSocket.OPEN || self.waitingReset) return;
        if (self.ws.bufferedAmount > 300000) return;
        var input = event.inputBuffer.getChannelData(0);
        var out = self._resample(input, self.context.sampleRate, 16000);
        var bytes = new Uint8Array(out.length * 2);
        var view = new DataView(bytes.buffer);
        for (var i = 0; i < out.length; i++) {
            var value = Math.max(-1, Math.min(1, out[i]));
            view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
        }
        var binary = '';
        for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
        self.ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
    };
    this.micSource.connect(this.microphoneNode);
    this.microphoneNode.connect(this.context.destination); // output buffer is silent
};
NpcGeminiVoice.prototype._resample = function (input, sourceRate, targetRate) {
    var len = Math.max(1, Math.round(input.length * targetRate / sourceRate));
    var out = new Float32Array(len);
    var ratio = sourceRate / targetRate;
    for (var i = 0; i < len; i++) {
        var from = Math.floor(i * ratio);
        var to = Math.min(input.length, Math.floor((i + 1) * ratio));
        var sum = 0;
        for (var j = from; j < to; j++) sum += input[j];
        out[i] = sum / Math.max(1, to - from);
    }
    return out;
};
NpcGeminiVoice.prototype._playPcm = function (base64, sampleRate) {
    if (!this.context) return;
    try {
        var raw = atob(base64);
        var len = Math.floor(raw.length / 2);
        var buffer = this.context.createBuffer(1, len, sampleRate);
        var samples = buffer.getChannelData(0);
        for (var i = 0; i < len; i++) {
            var value = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
            if (value & 0x8000) value -= 65536;
            samples[i] = value / 32768;
        }
        var source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        var start = Math.max(this.context.currentTime + 0.025, this.nextAudioAt);
        source.start(start);
        this.nextAudioAt = start + buffer.duration;
        this.playing.push(source);
        var self = this;
        source.onended = function () { self.playing = self.playing.filter(function (s) { return s !== source; }); };
    } catch (e) { this._status('Error reproduciendo voz: ' + e.message); }
};
NpcGeminiVoice.prototype._stopPlayback = function () {
    this.playing.forEach(function (source) { try { source.stop(); } catch (e) {} });
    this.playing = [];
    this.nextAudioAt = 0;
};
NpcGeminiVoice.prototype._stopMic = function () {
    if (this.microphoneNode) { this.microphoneNode.disconnect(); this.microphoneNode.onaudioprocess = null; this.microphoneNode = null; }
    if (this.micSource) { this.micSource.disconnect(); this.micSource = null; }
    if (this.mic) { this.mic.getTracks().forEach(function (t) { t.stop(); }); this.mic = null; }
};
NpcGeminiVoice.prototype.end = function () {
    this.started = false;
    this.connecting = false;
    this.waitingReset = false;
    this._stopMic();
    this._stopPlayback();
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    this._status('Conversación terminada.');
};
NpcGeminiVoice.prototype.reset = async function () {
    if (this.waitingReset) return;
    this.waitingReset = true;
    this._stopMic();
    this._stopPlayback();
    this._status('Restableciendo memoria...');
    try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'reset' }));
        } else {
            // An empty Live connection is currently used to authenticate a reset.
            // The next iteration will use a dedicated short-lived HTTP reset ticket.
            var ticket = await this._ticket();
            var self = this;
            this.ws = new WebSocket(ticket.backend.replace(/^http/, 'ws') + '/live?token=' + encodeURIComponent(ticket.token));
            this.ws.onmessage = function (event) { self._handle(JSON.parse(event.data)); };
            this.ws.onerror = function () { self.waitingReset = false; self._status('No se pudo restablecer: servidor inaccesible'); };
        }
    } catch (e) { this.waitingReset = false; this._status('Error: ' + e.message); }
};
NpcGeminiVoice.prototype._onDestroy = function () {
    this.end();
    if (this.panel) this.panel.remove();
    if (this.context) this.context.close();
};
