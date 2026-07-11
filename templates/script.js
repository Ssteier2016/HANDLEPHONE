let ws = null;
let userId = null;
let currentGroup = null;
let isRecording = false;
let isGroupRecording = false;
let activeDirectTarget = null; // Target user ID for direct operator-to-operator messaging
let isRecordingDirect = false; // Flag for DM recording state
let recordingStartTime = null; // Recording start timestamp to measure audio duration
const playedMessageIds = new Set(JSON.parse(localStorage.getItem('playedMessageIds') || '[]'));
let isMuted = false;
let isGroupMuted = false;
let isNonGroupMuted = false;
let mediaRecorder = null;
let audioChunks = [];
let flightData = [];
let map = null;
let markers = [];
let isSwiping = false;
let startX = 0;
let currentX = 0;
let currentAudio = null;
let clientMutedUsers = new Set();
let updatesEnabled = true;
let departureAnnouncementsEnabled = false;
let announcementsEnabled = false;
let restrictTokens = JSON.parse(localStorage.getItem('restrictTokens') || 'false');
let dailyTokenCount = parseInt(localStorage.getItem('dailyTokenCount') || '0', 10);
const MAX_TOKENS_DAILY = 2000;
const TOKENS_PER_FLIGHT = 1;
const MAX_FLIGHTS_PER_REQUEST = 20;

// VU Meter state
let bellAlerts = new Set();
let firedBellAlerts = new Set();
let vuAudioContext = null;
let vuAnalyser = null;
let vuDataArray = null;
let vuAnimFrame = null;
let vuStream = null;

const AIRPORT_MAPPING = {
    'SABE': 'Aeroparque',
    'SAEZ': 'Ezeiza',
    // Agrega más mapeos según sea necesario
};

// PAX lookup by ICAO aircraft type code
const PAX_LOOKUP = {
    'B738': 189, 'B737': 149, 'B739': 215, 'B38M': 178, 'B39M': 220,
    'A319': 128, 'A320': 150, 'A321': 185, 'A20N': 165, 'A21N': 210,
    'E190': 106, 'E195': 124, 'E170': 80, 'E175': 88,
    'AT72': 70, 'AT43': 50, 'CRJ7': 70, 'CRJ9': 90,
    'B744': 416, 'B748': 467, 'B77W': 396, 'A333': 296, 'A332': 253,
    'A359': 315, 'A388': 555, 'B789': 296, 'B788': 242,
    'N/A': 'N/A'
};

function isTargetAirline(flightNumber) {
    if (!flightNumber) return false;
    const prefixes = ['AR', 'ARG', 'LA', 'LAN', 'JJ', 'TAM', 'LP', 'LPE', 'XL', 'LNE', '4M', 'DSM', 'LAP', 'WJ', 'FO', 'FB', 'G3', 'GLO'];
    return prefixes.some(p => flightNumber.toUpperCase().startsWith(p));
}

// ─── VU METER ─────────────────────────────────────────────────────────────────
function startVuMeter(stream) {
    try {
        vuAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        vuAnalyser = vuAudioContext.createAnalyser();
        vuAnalyser.fftSize = 256;
        vuAnalyser.smoothingTimeConstant = 0.6;
        vuDataArray = new Uint8Array(vuAnalyser.frequencyBinCount);
        const source = vuAudioContext.createMediaStreamSource(stream);
        source.connect(vuAnalyser);
        animateVuMeter();
    } catch (e) {
        console.warn('VU meter no disponible:', e);
    }
}

function stopVuMeter() {
    if (vuAnimFrame) {
        cancelAnimationFrame(vuAnimFrame);
        vuAnimFrame = null;
    }
    if (vuAudioContext) {
        vuAudioContext.close().catch(() => {});
        vuAudioContext = null;
        vuAnalyser = null;
        vuDataArray = null;
    }
    // Reset all bars to idle state
    const bars = document.querySelectorAll('#vu-meter .vu-bar');
    bars.forEach(bar => {
        bar.style.height = '4px';
        bar.style.background = '#1e293b';
    });
}

function animateVuMeter() {
    if (!vuAnalyser || !vuDataArray) return;
    vuAnimFrame = requestAnimationFrame(animateVuMeter);
    vuAnalyser.getByteFrequencyData(vuDataArray);

    // Average across frequency bins — take lower half for voice range
    const voiceBins = vuDataArray.slice(0, vuDataArray.length / 3);
    const avg = voiceBins.reduce((s, v) => s + v, 0) / voiceBins.length;
    // Normalize 0..255 to 0..1
    const level = Math.min(1, avg / 160);

    const bars = document.querySelectorAll('#vu-meter .vu-bar');
    const NUM_BARS = bars.length; // 16
    const MAX_HEIGHT = 40; // px (h-10 = 40px)
    const MIN_HEIGHT = 3;

    bars.forEach((bar, i) => {
        const barThreshold = (i + 1) / NUM_BARS; // 0.0625 .. 1.0
        const isActive = level >= barThreshold;
        // Height: active bars grow taller towards the right
        const h = isActive
            ? Math.max(MIN_HEIGHT, barThreshold * MAX_HEIGHT * (1 + level * 0.3))
            : MIN_HEIGHT;
        bar.style.height = Math.min(MAX_HEIGHT, h) + 'px';

        // Color gradient: green (low) → amber (mid) → red (high)
        if (!isActive) {
            bar.style.background = '#1e293b'; // slate-900 idle
        } else if (barThreshold < 0.6) {
            bar.style.background = '#22c55e'; // green-500
        } else if (barThreshold < 0.85) {
            bar.style.background = '#f59e0b'; // amber-500
        } else {
            bar.style.background = '#ef4444'; // red-500
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────



function getAirlineLogoHtml(flightNumber) {
    if (!flightNumber) return '';
    const fn = flightNumber.trim().toUpperCase();
    
    // Aerolineas Argentinas logo
    if (fn.startsWith('AR') || fn.startsWith('ARG')) {
        return `<img src="https://i.pinimg.com/1200x/7c/cb/a8/7ccba809b9309e29383287a7c94a6978.jpg" alt="AR Logo" class="h-5 w-9 object-contain inline-block mr-2 bg-white rounded p-0.5" style="vertical-align: middle;">`;
    }
    
    // LATAM divisions logo
    const latamPrefixes = ['LA', 'LAN', 'JJ', 'TAM', 'LP', 'LPE', 'XL', 'LNE', '4M', 'DSM', 'LAP'];
    const matchesLatam = latamPrefixes.some(pref => fn.startsWith(pref));
    if (matchesLatam) {
        return `<img src="https://i.pinimg.com/1200x/6a/f0/e0/6af0e032470f2d35acb5e3f225fe1da7.jpg" alt="LA Logo" class="h-5 w-9 object-contain inline-block mr-2 bg-white rounded p-0.5" style="vertical-align: middle;">`;
    }
    
    // Fallback: plane icon
    return `<span class="inline-block mr-2 text-slate-500">✈</span>`;
}

const playedBellAlerts = new Set();

function playBellSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        const frequencies = [880, 1200, 1500, 1800];
        frequencies.forEach((freq, index) => {
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now);
            const duration = 1.2 / (index + 1);
            gainNode.gain.setValueAtTime(0.1, now);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + duration);
        });
    } catch (err) {
        console.error("Error al reproducir timbre de campana:", err);
    }
}

function getFlightTargetTime(flight) {
    if (!flight) return null;
    const timeStr = (flight.eta && flight.eta !== 'N/A') ? flight.eta : flight.sta;
    if (!timeStr || timeStr === 'N/A') return null;
    
    const now = new Date();
    // Caso 1: "DD/MM HH:MM" (ej., "07/07 04:40")
    if (timeStr.includes('/')) {
        const parts = timeStr.split(' ');
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        const day = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1;
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);
        return new Date(now.getFullYear(), month, day, hour, minute, 0);
    }
    
    // Caso 2: "HH:MM" (ej., "04:15")
    if (timeStr.includes(':')) {
        const timeParts = timeStr.split(':');
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    }
    return null;
}

function updateCountdowns() {
    const cells = document.querySelectorAll('.flight-countdown-cell');
    const nowMs = Date.now();
    
    cells.forEach(cell => {
        const targetMsStr = cell.getAttribute('data-target-ms');
        const flightNumber = cell.getAttribute('data-flight-number') || 'Unknown';
        const bellEnabled = bellAlerts.has(flightNumber);
        
        if (!targetMsStr) {
            cell.querySelector('.countdown-text')?.setAttribute('data-val', '-');
            return;
        }
        
        const targetMs = parseInt(targetMsStr, 10);
        const diffMs = targetMs - nowMs;
        let timeText = '';
        let timeClass = 'text-slate-400';
        let bellClass = bellEnabled ? 'text-amber-400 cursor-pointer' : 'text-slate-600 cursor-pointer';
        let bellTitle = bellEnabled ? 'Desactivar alerta' : 'Activar alerta para este vuelo';
        
        if (isNaN(targetMs) || targetMsStr === '') {
            timeText = 'N/A';
        } else if (diffMs > 0) {
            const totalSeconds = Math.floor(diffMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const hStr = hours > 0 ? `${hours}:` : '';
            const mStr = String(minutes).padStart(2, '0');
            const sStr = String(seconds).padStart(2, '0');
            timeText = `${hStr}${mStr}:${sStr}`;
            if (bellEnabled && diffMs < 300000) {
                timeClass = 'text-amber-400 font-bold font-mono animate-pulse';
            } else {
                timeClass = 'text-slate-300 font-mono';
            }
        } else {
            // Flight is at or past its scheduled time
            timeText = '00:00';
            timeClass = 'text-red-400 font-bold font-mono';
            // Only fire bell if: bell is enabled AND not already fired AND app has been running for at least 5s (not startup)
            if (bellEnabled && !firedBellAlerts.has(flightNumber)) {
                firedBellAlerts.add(flightNumber);
                // Only play sound if we're past the startup grace period (5 seconds)
                if (Date.now() - startupTime > 5000) {
                    playBellSound();
                    showError(`¡Vuelo ${flightNumber} en hora cero!`);
                }
            } else if (!bellEnabled && !firedBellAlerts.has(flightNumber)) {
                // Silently mark past flights as fired so they don't trigger on bell enable
                firedBellAlerts.add(flightNumber);
            }
        }
        
        const existingText = cell.querySelector('.countdown-text');
        const existingBell = cell.querySelector('.bell-btn');
        
        if (existingText) {
            existingText.textContent = timeText;
            existingText.className = `countdown-text ${timeClass}`;
        }
        if (existingBell) {
            existingBell.className = `bell-btn text-base ${bellClass}`;
            existingBell.title = bellTitle;
        }
    });
}

function showError(message, isSuccess = false) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        if (isSuccess) {
            // Success: green styles
            errorDiv.className = "text-emerald-400 text-sm text-center bg-emerald-950/40 border border-emerald-900/50 p-2.5 rounded-xl";
        } else {
            // Error: red styles
            errorDiv.className = "text-red-400 text-sm text-center bg-red-950/40 border border-red-900/50 p-2.5 rounded-xl";
        }
        setTimeout(() => { errorDiv.style.display = 'none'; }, 7000);
    }
    if (isSuccess) {
        console.log(message);
    } else {
        console.error(message);
    }
}

async function loginUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname-login')?.value.trim() || '';
    const employee_id = document.getElementById('employee_id-login')?.value.trim() || '';
    const password = document.getElementById('password-login')?.value || '';
    console.log("Intentando login con:", { surname, employee_id });
    if (!surname || !employee_id || !password) {
        showError('Por favor, completa todos los campos.', false);
        return;
    }
    if (!/^\d{5,6}$/.test(employee_id)) {
        showError('El legajo debe contener entre 5 y 6 números.', false);
        return;
    }
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, password }),
        });
        const data = await response.json();
        console.log("Respuesta de /login:", response.status, data);
        if (response.ok) {
            localStorage.setItem('sessionToken', data.token);
            const decoded = atob(data.token);
            const [emp_id, surn, sector] = decoded.split('_');
            localStorage.setItem('userName', surn);
            localStorage.setItem('userFunction', sector);
            localStorage.setItem('userLegajo', emp_id);
            userId = `${emp_id}_${surn}_${sector}`;
            connectWebSocket(data.token);
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            displayUserProfile();
            updateOpenSkyData();
            showError('Inicio de sesión exitoso', true);
        } else {
            const errorMessage = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || 'Error desconocido');
            showError(`Error al iniciar sesión: ${errorMessage}`, false);
        }
    } catch (error) {
        showError('Error de conexión con el servidor.', false);
        console.error('Error al iniciar sesión:', error);
    }
}

async function registerUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname')?.value.trim() || '';
    const employee_id = document.getElementById('employee_id')?.value.trim() || '';
    const sector = document.getElementById('sector')?.value || '';
    const password = document.getElementById('password')?.value || '';
    console.log("Intentando registro con:", { surname, employee_id, sector });
    if (!surname || !employee_id || !sector || !password) {
        showError('Por favor, completa todos los campos.', false);
        return;
    }
    if (!/^\d{5,6}$/.test(employee_id)) {
        showError('El legajo debe contener entre 5 y 6 números.', false);
        return;
    }
    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, sector, password }),
        });
        const data = await response.json();
        console.log("Respuesta de /register:", response.status, data);
        if (response.ok) {
            // Auto login user after registration so it's a true one-time process
            showError('Registro exitoso. Iniciando sesión automáticamente...', true);
            // Attempt to login programmatically immediately
            const loginResponse = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ surname, employee_id, password }),
            });
            const loginData = await loginResponse.json();
            if (loginResponse.ok) {
                localStorage.setItem('sessionToken', loginData.token);
                localStorage.setItem('userName', surname);
                localStorage.setItem('userFunction', sector);
                localStorage.setItem('userLegajo', employee_id);
                // Also persist registration flag
                localStorage.setItem('isRegistered', 'true');
                
                userId = `${employee_id}_${surname}_${sector}`;
                connectWebSocket(loginData.token);
                document.getElementById('auth-section').style.display = 'none';
                document.getElementById('main').style.display = 'block';
                displayUserProfile();
                updateOpenSkyData();
            } else {
                document.getElementById('register-form').style.display = 'none';
                document.getElementById('login-form').style.display = 'block';
            }
        } else {
            const errorMessage = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || 'Error desconocido');
            showError(`Error al registrarse: ${errorMessage}`, false);
        }
    } catch (error) {
        showError('Error de conexión con el servidor.', false);
        console.error('Error al registrarse:', error);
    }
}

let wakeLock = null;
let keepAliveAudio = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock activo en pantalla');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock fue liberado');
            });
        }
    } catch (err) {
        console.warn('Wake Lock no soportado o fallido:', err);
    }
}

function startAudioKeepAlive() {
    try {
        if (!keepAliveAudio) {
            // Generar un audio silencioso en loop de 1 segundo
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            source.connect(audioCtx.destination);
            source.start();
            keepAliveAudio = audioCtx;
            console.log('Audio Keep-Alive iniciado');
        }
    } catch (e) {
        console.warn('Audio Keep-Alive no soportado:', e);
    }
}

function connectWebSocket(token) {
    requestWakeLock();
    startAudioKeepAlive();
    
    window.isWsHistoryLoaded = false;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    ws = new WebSocket(`wss://${window.location.host}/ws/${token}`);
    ws.onopen = () => {
        console.log("WebSocket conectado");
        startPing();
    };
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log("Mensaje WebSocket:", data);
            if (data.type === 'connection_success') {
                // connection_success arrives BEFORE history - reset flag
                window.isWsHistoryLoaded = false;
            } else if (data.type === 'history_end') {
                // All history has been sent - from now on new messages auto-play
                window.isWsHistoryLoaded = true;
                console.log('Historial cargado. Auto-play de audio activado.');
            } else if (data.type === 'message' || data.type === 'group_message' || data.type === 'direct_message') {
                displayMessage(data);
                // Only auto-play if it's not from history loading AND NOT our own recorded audio AND NOT already played
                const myToken = localStorage.getItem('sessionToken');
                const isMine = data.sender_token && data.sender_token === myToken;
                const msgId = data.id || null;
                const alreadyPlayed = msgId !== null && playedMessageIds.has(msgId);
                
                if (data.audio && window.isWsHistoryLoaded && !isMine && !alreadyPlayed) {
                    if (msgId !== null) {
                        playedMessageIds.add(msgId);
                        localStorage.setItem('playedMessageIds', JSON.stringify(Array.from(playedMessageIds)));
                    }
                    playAudio(data.audio, data.sender, data.type === 'group_message' ? data.group_id : null);
                }
            } else if (data.type === 'user_list') {
                updateUserList(data.users);
            } else if (data.type === 'group_joined') {
                currentGroup = data.group_id;
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                
                const shareBadge = document.getElementById('group-share-badge');
                const shareCodeSpan = document.getElementById('group-share-code');
                if (shareCodeSpan) shareCodeSpan.textContent = currentGroup;
                if (shareBadge) {
                    shareBadge.onclick = () => {
                        navigator.clipboard.writeText(currentGroup).then(() => {
                            const originalHTML = shareBadge.innerHTML;
                            shareBadge.innerHTML = '<span>Copiado!</span> ✅';
                            setTimeout(() => {
                                shareBadge.innerHTML = originalHTML;
                            }, 2000);
                        }).catch(err => {
                            console.error('Error al copiar código:', err);
                        });
                    };
                }
                
                updateSwipeHint();
                updateFlightInfo();
            } else if (data.type === 'group_left') {
                currentGroup = null;
                document.getElementById('group-screen').style.display = 'none';
                document.getElementById('main').style.display = 'block';
                updateSwipeHint();
            } else if (data.type === 'error') {
                showError(data.message);
                if (data.message.includes('Usuario no registrado') || data.message.includes('Token no registrado') || data.message.includes('Sesión inválida')) {
                    completeLogout();
                }
            } else if (data.type === 'logout_success') {
                completeLogout();
            } else if (data.type === 'flight_update') {
                flightData = data.flights.filter(f => f && f.flight_number);
                updateFlightInfo();
                updateMap();
            }
        } catch (err) {
            console.error("Error al procesar mensaje WebSocket:", err);
        }
    };
    ws.onclose = () => {
        console.log("WebSocket cerrado");
        stopPing();
        setTimeout(() => connectWebSocket(token), 5000);
    };
    ws.onerror = (error) => {
        console.error("Error en WebSocket:", error);
    };
}

function startPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    // Also request fresh user list on each ping
    ws.send(JSON.stringify({ type: 'refresh_users' }));
    setTimeout(startPing, 10000);
}

function stopPing() {
    // No se necesita implementación explícita para detener pings
}

function displayUserProfile() {
    const profileDiv = document.getElementById('user-profile');
    if (profileDiv) {
        const name = localStorage.getItem('userName') || 'Usuario';
        const role = localStorage.getItem('userFunction') || 'Rol desconocido';
        profileDiv.innerHTML = `<span>Usuario: <b>${name}</b></span> <span class="text-slate-600">|</span> <span>Rol: <b class="text-sky-400">${role}</b></span>`;
    }
}

function updateUserList(users) {
    const listContainer = document.getElementById('users-list-container');
    const groupListContainer = document.getElementById('group-users-list-container');
    
    // Clear and build main operators list
    if (listContainer) {
        listContainer.innerHTML = '';
        if (users.length === 0) {
            listContainer.innerHTML = '<div class="text-xs text-slate-500 italic py-1">No hay operadores activos</div>';
        } else {
            users.forEach(user => {
                const isMuted = clientMutedUsers.has(user.user_id);
                const isSelf = user.user_id === userId;
                
                const card = document.createElement('div');
                card.className = "flex items-center justify-between bg-slate-900/80 border border-slate-800/80 px-3 py-2 rounded-xl text-xs gap-2";
                card.innerHTML = `
                    <div class="flex flex-col min-w-0 flex-grow">
                        <span class="text-slate-200 font-bold truncate">${user.display}</span>
                        <span class="text-[10px] text-slate-500 font-mono">${user.user_id.split('_')[1] || ''}</span>
                    </div>
                    ${!isSelf ? `
                        <div class="flex items-center gap-1 flex-shrink-0">
                            <button class="dm-user-btn p-1.5 rounded-lg border transition m-0 w-auto bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white" title="Mensaje Directo de Voz" data-user-id="${user.user_id}">
                                🎤
                            </button>
                            <button class="mute-user-btn px-2.5 py-1 rounded-lg font-bold border transition text-[10px] m-0 w-auto ${isMuted ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'}" data-user-id="${user.user_id}">
                                ${isMuted ? 'Silenciado' : 'Mutear'}
                            </button>
                        </div>
                    ` : '<span class="text-[10px] text-sky-400 font-mono bg-sky-950/40 px-1.5 py-0.5 rounded-md">Tú</span>'}
                `;
                
                const muteBtn = card.querySelector('.mute-user-btn');
                if (muteBtn) {
                    muteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleIndividualMute(user.user_id, muteBtn);
                    });
                }

                const dmBtn = card.querySelector('.dm-user-btn');
                if (dmBtn) {
                    dmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        startDirectRecordingFlow(user.user_id, dmBtn);
                    });
                }
                listContainer.appendChild(card);
            });
        }
    }

    // Clear and build group members list
    if (groupListContainer) {
        groupListContainer.innerHTML = '';
        const groupMembers = users.filter(u => u.group_id === currentGroup);
        if (groupMembers.length === 0) {
            groupListContainer.innerHTML = '<div class="text-xs text-slate-500 italic py-1">No hay miembros en el canal</div>';
        } else {
            groupMembers.forEach(user => {
                const isMuted = clientMutedUsers.has(user.user_id);
                const isSelf = user.user_id === userId;
                
                const card = document.createElement('div');
                card.className = "flex items-center justify-between bg-slate-900/80 border border-slate-800/80 px-3 py-2 rounded-xl text-xs gap-2";
                card.innerHTML = `
                    <div class="flex flex-col min-w-0 flex-grow">
                        <span class="text-slate-200 font-bold truncate">${user.display}</span>
                        <span class="text-[10px] text-slate-500 font-mono">${user.user_id.split('_')[1] || ''}</span>
                    </div>
                    ${!isSelf ? `
                        <div class="flex items-center gap-1 flex-shrink-0">
                            <button class="dm-user-btn p-1.5 rounded-lg border transition m-0 w-auto bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white" title="Mensaje Directo de Voz" data-user-id="${user.user_id}">
                                🎤
                            </button>
                            <button class="mute-user-btn px-2.5 py-1 rounded-lg font-bold border transition text-[10px] m-0 w-auto ${isMuted ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'}" data-user-id="${user.user_id}">
                                ${isMuted ? 'Silenciado' : 'Mutear'}
                            </button>
                        </div>
                    ` : '<span class="text-[10px] text-sky-400 font-mono bg-sky-950/40 px-1.5 py-0.5 rounded-md">Tú</span>'}
                `;
                
                const muteBtn = card.querySelector('.mute-user-btn');
                if (muteBtn) {
                    muteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleIndividualMute(user.user_id, muteBtn);
                    });
                }
                
                const dmBtn = card.querySelector('.dm-user-btn');
                if (dmBtn) {
                    dmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        startDirectRecordingFlow(user.user_id, dmBtn);
                    });
                }
                groupListContainer.appendChild(card);
            });
        }
    }
}

function startDirectRecordingFlow(targetUserId, btnElement) {
    const targetName = targetUserId.split('_')[0];
    activeDirectTarget = targetUserId;
    
    // Update main talk status indicator and make it clear we are in DM mode
    const statusText = document.getElementById('talk-status');
    const talkButton = document.getElementById('talk');
    
    if (statusText) {
        statusText.textContent = `🎤 DM para ${targetName} (Toca Talk)`;
        statusText.className = 'text-xs text-amber-400 font-mono font-bold animate-pulse';
    }
    
    if (talkButton) {
        talkButton.innerHTML = `<div class="w-24 h-24 rounded-full bg-gradient-to-b from-amber-600 to-amber-800 hover:from-amber-500 hover:to-amber-700 active:scale-95 border-4 border-amber-400/40 shadow-lg shadow-amber-900/50 flex items-center justify-center transition-all">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V21h2v-2.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
        </div>`;
    }
    
    // Highlight the target row temporarily
    const originalBg = btnElement.parentElement.parentElement.className;
    btnElement.parentElement.parentElement.className = btnElement.parentElement.parentElement.className + " border-amber-500 ring-1 ring-amber-500/50";
    
    // Clear DM target automatically if they don't record within 15 seconds
    setTimeout(() => {
        if (activeDirectTarget === targetUserId && !isRecording) {
            cancelDirectRecordingFlow();
        }
        btnElement.parentElement.parentElement.className = originalBg;
    }, 15000);
}

function cancelDirectRecordingFlow() {
    activeDirectTarget = null;
    const statusText = document.getElementById('talk-status');
    const talkButton = document.getElementById('talk');
    
    if (statusText) {
        statusText.textContent = 'Presioná para hablar';
        statusText.className = 'text-xs text-slate-500 font-mono';
    }
    
    if (talkButton) {
        talkButton.innerHTML = `<div class="w-24 h-24 rounded-full bg-gradient-to-b from-sky-600 to-sky-800 hover:from-sky-500 hover:to-sky-700 active:scale-95 border-4 border-sky-400/40 shadow-lg shadow-sky-900/50 flex items-center justify-center transition-all">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V21h2v-2.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
        </div>`;
    }
}

function toggleIndividualMute(targetUserId, btnElement) {
    if (clientMutedUsers.has(targetUserId)) {
        clientMutedUsers.delete(targetUserId);
        btnElement.textContent = 'Mutear';
        btnElement.className = "mute-user-btn px-2.5 py-1 rounded-lg font-bold border transition text-[10px] m-0 w-auto bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700";
        // Notify backend too (sync state)
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'unmute_user', target_user_id: targetUserId }));
        }
    } else {
        clientMutedUsers.add(targetUserId);
        btnElement.textContent = 'Silenciado';
        btnElement.className = "mute-user-btn px-2.5 py-1 rounded-lg font-bold border transition text-[10px] m-0 w-auto bg-red-500/20 text-red-400 border-red-500/30";
        // Notify backend too (sync state)
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'mute_user', target_user_id: targetUserId }));
        }
    }
}

function displayMessage(data) {
    // Best detection: compare sender_token with our own session token
    const myToken = localStorage.getItem('sessionToken');
    const myName = localStorage.getItem('userName');
    const isMine = data.sender_token 
        ? (data.sender_token === myToken)
        : (data.sender === myName || data.sender === userId);
    const chatList = data.type === 'group_message' ? document.getElementById('group-chat-list') : document.getElementById('chat-list');
    if (!chatList) return;

    // Check if message is already displayed by unique ID to prevent duplicates
    if (data.id) {
        const duplicate = chatList.querySelector(`[data-msg-id="${data.id}"]`);
        if (duplicate) {
            // Update transcription text if it was pending
            const textEl = duplicate.querySelector('.msg-text');
            if (textEl && (textEl.textContent === 'Pendiente de transcripción' || textEl.textContent === 'Mensaje de voz') && data.text) {
                textEl.textContent = data.text;
            }
            return;
        }
    }

    // Fallback: Check if we already have this message with "Pendiente de transcripción" to update it
    const messages = chatList.querySelectorAll('.chat-message');
    let existingMsgDiv = null;
    const name = data.sender ? data.sender.split('_')[0] : (isMine ? 'Tú' : 'Desconocido');
    
    for (const msg of messages) {
        const msgSender = msg.querySelector('.sender-name')?.textContent;
        const msgTime = msg.querySelector('.msg-time')?.textContent;
        const msgText = msg.querySelector('.msg-text')?.textContent;
        if ((msgSender === name || msgSender === 'Tú') && msgTime === data.timestamp && (msgText === 'Pendiente de transcripción' || msgText === 'Mensaje de voz')) {
            existingMsgDiv = msg;
            break;
        }
    }

    if (existingMsgDiv) {
        // Update text content with final transcription
        const textElement = existingMsgDiv.querySelector('.msg-text');
        if (textElement) {
            textElement.textContent = data.text || 'Mensaje de voz';
        }
        if (data.id) {
            existingMsgDiv.setAttribute('data-msg-id', data.id);
        }
        return;
    }

    const messageDiv = document.createElement('div');
    if (data.id) {
        messageDiv.setAttribute('data-msg-id', data.id);
    }
    messageDiv.className = `chat-message flex items-start gap-2 p-2 rounded-xl mb-1 ${isMine ? 'bg-sky-900/30 border border-sky-800/30' : 'bg-slate-800/40'}`;
    const timestamp = data.timestamp || '';
    const durationText = data.duration ? `<span class="text-[9px] text-slate-500 ml-1 font-mono">${data.duration}s</span>` : '';
    
    messageDiv.innerHTML = `
        <div class="flex-shrink-0 w-7 h-7 rounded-full ${isMine ? 'bg-sky-600' : 'bg-slate-700'} flex items-center justify-center text-xs font-bold text-white">
            ${name[0]?.toUpperCase() || '?'}
        </div>
        <div class="flex-grow min-w-0">
            <div class="flex items-center gap-2">
                <span class="sender-name text-xs font-bold ${isMine ? 'text-sky-400' : 'text-slate-300'}">${isMine ? 'Tú' : name}</span>
                <span class="msg-time text-[10px] text-slate-500 font-mono">${timestamp}</span>
                ${durationText}
            </div>
            <p class="msg-text text-sm text-slate-200 leading-snug mt-0.5">${data.text || 'Mensaje de voz'}</p>
        </div>
        ${data.audio ? '<button class="play-btn flex-shrink-0 w-7 h-7 rounded-full bg-sky-600/20 hover:bg-sky-600/40 text-sky-400 flex items-center justify-center text-xs transition">▶</button>' : ''}
    `;
    if (data.audio) {
        const playBtn = messageDiv.querySelector('.play-btn');
        playBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            playAudio(data.audio, data.sender, data.type === 'group_message' ? data.group_id : null, playBtn);
        });
    }
    chatList.appendChild(messageDiv);
    chatList.scrollTop = chatList.scrollHeight;
}

async function playAudio(audioData, sender, groupId, btnElement = null) {
    try {
        // Skip playback if this user has been individually muted
        if (sender && clientMutedUsers.has(sender)) {
            console.log(`Audio de ${sender} omitido porque el usuario está silenciado.`);
            return;
        }

        // If same audio is clicked, toggle play/pause
        if (currentAudio && currentAudio._audioData === audioData) {
            if (currentAudio.paused) {
                currentAudio.play();
                if (btnElement) btnElement.textContent = '⏸';
            } else {
                currentAudio.pause();
                if (btnElement) btnElement.textContent = '▶';
            }
            return;
        }

        // Stop any currently playing audio
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            // Reset all buttons to play state
            document.querySelectorAll('.play-btn').forEach(btn => btn.textContent = '▶');
        }

        const audioBlob = base64ToBlob(audioData, 'audio/webm');
        if (!audioBlob) throw new Error("No se pudo convertir el audio");
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio._audioData = audioData; // unique key identifier
        currentAudio = audio;
        
        if (btnElement) btnElement.textContent = '⏸';
        
        // Handle Mobile Autoplay user interaction restrictions
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("Audio reproducido automáticamente.");
            }).catch(err => {
                console.warn("Autoplay bloqueado. Despertando AudioContext en primer toque del usuario.", err);
                // Setup a one-time document touch listener to play the audio once user interacts
                const unlockPlayback = () => {
                    audio.play();
                    document.removeEventListener('click', unlockPlayback);
                    document.removeEventListener('touchstart', unlockPlayback);
                };
                document.addEventListener('click', unlockPlayback);
                document.addEventListener('touchstart', unlockPlayback);
            });
        }
        
        audio.onended = () => { 
            URL.revokeObjectURL(audioUrl);
            if (btnElement) btnElement.textContent = '▶';
            if (currentAudio === audio) currentAudio = null;
        };
        audio.onpause = () => {
            if (btnElement && currentAudio === audio) btnElement.textContent = '▶';
        };
    } catch (err) {
        console.error("Error al reproducir audio:", err);
        showError("Error al reproducir el mensaje de audio.");
    }
}

async function toggleTalk(forceState = null) {
    const talkButton = document.getElementById('talk');
    const statusText = document.getElementById('talk-status');
    const ring1 = document.getElementById('talk-ring-1');
    const ring2 = document.getElementById('talk-ring-2');
    if (!talkButton) return;

    const targetState = forceState !== null ? forceState : !isRecording;
    if (targetState === isRecording) return; // Already in target state

    if (targetState) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const durationSecs = Math.round((Date.now() - recordingStartTime) / 1000) || 1;
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64Audio = reader.result.split(',')[1];
                    const now = new Date();
                    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
                    const userFunction = localStorage.getItem('userFunction') || 'Operador';
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: activeDirectTarget ? 'direct_message' : 'message',
                            target_user_id: activeDirectTarget || undefined,
                            audio: base64Audio,
                            sender: userId,
                            function: userFunction,
                            timestamp: ts,
                            duration: durationSecs,
                            text: 'Pendiente de transcripción'
                        }));
                    }
                };
                stream.getTracks().forEach(track => track.stop());
            };
            recordingStartTime = Date.now();
            mediaRecorder.start();
            isRecording = true;
            startVuMeter(stream); // Start VU meter with same mic stream
            // Visual feedback: red button + pulse rings
            talkButton.innerHTML = `<div class="w-24 h-24 rounded-full bg-gradient-to-b from-red-600 to-red-800 border-4 border-red-400/60 shadow-lg shadow-red-900/60 flex items-center justify-center transition-all animate-pulse">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V21h2v-2.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
            </div>`;
            if (statusText) { statusText.textContent = '🔴 TRANSMITIENDO...'; statusText.className = 'text-xs text-red-400 font-mono font-bold animate-pulse'; }
            if (ring1) ring1.className = 'absolute w-28 h-28 rounded-full border-2 border-red-400/40 animate-ping';
            if (ring2) ring2.className = 'absolute w-36 h-36 rounded-full border-2 border-red-400/20 animate-ping';
        } catch (err) {
            showError("Error al acceder al micrófono.");
            console.error("Error al grabar:", err);
            isRecording = false;
        }
    } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        isRecording = false;
        stopVuMeter(); // Stop VU meter and reset bars
        // Restore button to normal
        talkButton.innerHTML = `<div class="w-24 h-24 rounded-full bg-gradient-to-b from-sky-600 to-sky-800 hover:from-sky-500 hover:to-sky-700 active:scale-95 border-4 border-sky-400/40 shadow-lg shadow-sky-900/50 flex items-center justify-center transition-all">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V21h2v-2.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
        </div>`;
        if (statusText) { statusText.textContent = 'Presioná para hablar'; statusText.className = 'text-xs text-slate-500 font-mono'; }
        if (ring1) ring1.className = 'absolute w-28 h-28 rounded-full border-2 border-sky-400/0 transition-all duration-300';
        if (ring2) ring2.className = 'absolute w-36 h-36 rounded-full border-2 border-sky-400/0 transition-all duration-300';
        activeDirectTarget = null; // Clear DM target after recording
    }
}

async function toggleGroupTalk(forceState = null) {
    const groupTalkButton = document.getElementById('group-talk');
    if (!groupTalkButton || !currentGroup) return;
    
    const targetState = forceState !== null ? forceState : !isGroupRecording;
    if (targetState === isGroupRecording) return; // Already in target state
    
    if (targetState) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const durationSecs = Math.round((Date.now() - recordingStartTime) / 1000) || 1;
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64Audio = reader.result.split(',')[1];
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'group_message',
                            group_id: currentGroup,
                            audio: base64Audio,
                            sender: userId,
                            duration: durationSecs,
                            text: 'Mensaje de voz'
                        }));
                    } else {
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'QUEUE_MESSAGE',
                            message: {
                                type: 'group_message',
                                group_id: currentGroup,
                                audio: base64Audio,
                                sender: userId,
                                duration: durationSecs,
                                text: 'Mensaje de voz'
                            }
                        });
                    }
                };
                stream.getTracks().forEach(track => track.stop());
            };
            recordingStartTime = Date.now();
            mediaRecorder.start();
            isGroupRecording = true;
            groupTalkButton.classList.add('recording');
        } catch (err) {
            showError("Error al acceder al micrófono.");
            console.error("Error al grabar en grupo:", err);
            isGroupRecording = false;
        }
    } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        isGroupRecording = false;
        groupTalkButton.classList.remove('recording');
    }
}

function toggleMute() {
    const muteButton = document.getElementById('mute');
    if (!muteButton) return;
    isMuted = !isMuted;
    
    // Clean swap: Speaker (unmuted) vs Speaker-off (muted)
    if (isMuted) {
        muteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="currentColor"><path d="M4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
    } else {
        muteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-slate-350" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute', muted: isMuted }));
    }
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById('group-mute');
    if (!groupMuteButton) return;
    isGroupMuted = !isGroupMuted;
    groupMuteButton.classList.toggle('muted', isGroupMuted);
    groupMuteButton.classList.toggle('unmuted', !isGroupMuted);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'group_mute', group_id: currentGroup, muted: isGroupMuted }));
    }
}

function toggleMuteNonGroup() {
    const muteNonGroupButton = document.getElementById('mute-non-group');
    if (!muteNonGroupButton) return;
    isNonGroupMuted = !isNonGroupMuted;
    muteNonGroupButton.classList.toggle('muted', isNonGroupMuted);
    muteNonGroupButton.classList.toggle('unmuted', !isNonGroupMuted);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute_non_group', muted: isNonGroupMuted }));
    }
}

function joinGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked;
    if (!groupId) {
        showError("Por favor, ingresa un nombre de grupo.");
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join_group',
            group_id: groupId,
            private: isPrivate,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    } else {
        showError("No hay conexión WebSocket. Intenta de nuevo.");
    }
}

function createGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked;
    if (!groupId) {
        showError("Por favor, ingresa un nombre de grupo.");
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'create_group',
            group_id: groupId,
            private: isPrivate,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    } else {
        showError("No hay conexión WebSocket. Intenta de nuevo.");
    }
}

function leaveGroup() {
    if (currentGroup && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'leave_group',
            group_id: currentGroup,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    }
}

function showRadar() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    if (!map) {
        initMap();
    }
    updateMap();
}

function showGroupRadar() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    if (!map) {
        initMap();
    }
    updateMap();
}

function backToMainFromRadar() {
    document.getElementById('radar-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    updateSwipeHint();
}

function backToMainFromGroup() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    updateSwipeHint();
}

function backToMainFromHistory() {
    document.getElementById('history-screen').style.display = 'none';
    if (currentGroup) {
        document.getElementById('group-screen').style.display = 'block';
    } else {
        document.getElementById('main').style.display = 'block';
    }
    updateSwipeHint();
}

async function showHistory() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    
    const historyList = document.getElementById('history-list');
    if (!historyList) return;
    historyList.innerHTML = '<div class="text-center text-slate-400 py-4 font-sans text-sm">Cargando historial...</div>';
    
    try {
        const token = localStorage.getItem('userToken') || '';
        const response = await fetch(`/api/history?token=${encodeURIComponent(token)}`);
        if (!response.ok) {
            throw new Error(`Error del servidor: ${response.status}`);
        }
        const messages = await response.json();
        historyList.innerHTML = '';
        if (messages.length === 0) {
            historyList.innerHTML = '<div class="text-center text-slate-400 py-4 font-sans text-sm">No hay mensajes grabados.</div>';
            return;
        }
        messages.forEach(msg => {
            const item = document.createElement('div');
            const parts = msg.user_id.split('_');
            const name = parts[0] || 'Desconocido';
            const sector = parts[1] || 'Sin sector';
            
            const durationText = msg.duration ? `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] font-semibold border border-slate-700 text-slate-400 font-mono">${msg.duration}s</span>` : '';
            item.className = 'p-3 bg-slate-900/60 border border-slate-800 rounded-xl flex items-center justify-between gap-4 hover:bg-slate-800/40 transition duration-150 cursor-pointer';
            item.innerHTML = `
                <div class="flex-grow">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs font-bold text-sky-400 font-sans">${name}</span>
                        <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] font-semibold border border-slate-700 text-slate-300 font-sans">${sector}</span>
                        <span class="text-[10px] text-slate-500 font-mono">${msg.timestamp || ''}</span>
                        ${durationText}
                    </div>
                    <p class="text-sm text-slate-200 font-sans font-medium">${msg.text || 'Mensaje de voz'}</p>
                </div>
                <div>
                    <button class="play-btn w-9 h-9 rounded-full bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 flex items-center justify-center transition border border-sky-500/10">
                        <span class="text-xs">▶</span>
                    </button>
                </div>
            `;
            item.addEventListener('click', () => {
                if (msg.audio) {
                    playAudio(msg.audio, name, null);
                }
            });
            historyList.appendChild(item);
        });
    } catch (err) {
        console.error("Error al cargar historial:", err);
        historyList.innerHTML = `<div class="text-center text-red-400 py-4 font-sans text-sm">Error al cargar historial: ${err.message}</div>`;
    }
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    showHistory();
}

function showFlightDetails(flight) {
    const modal = document.getElementById('flight-details-modal');
    const content = document.getElementById('flight-details-content');
    if (!modal || !content) return;
    content.innerHTML = `
        <p><b>Número de Vuelo:</b> ${flight.flight_number || 'N/A'}</p>
        <p><b>Matrícula:</b> ${flight.registration || 'N/A'}</p>
        <p><b>Origen:</b> ${AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A'}</p>
        <p><b>Destino:</b> ${AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A'}</p>
        <p><b>Hora Programada:</b> ${flight.sta ? new Date(flight.sta).toLocaleString() : 'N/A'}</p>
        <p><b>Hora Estimada:</b> ${flight.eta ? new Date(flight.eta).toLocaleString() : 'N/A'}</p>
        <p><b>Estado:</b> ${flight.status || 'N/A'}</p>
    `;
    modal.style.display = 'block';
}

function closeFlightDetails() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) modal.style.display = 'none';
}

async function updateOpenSkyData() {
    if (!updatesEnabled) {
        console.log("Actualizaciones pausadas");
        setTimeout(updateOpenSkyData, 15000);
        return;
    }
    if (restrictTokens && dailyTokenCount >= MAX_TOKENS_DAILY) {
        console.warn("Límite de tokens alcanzado:", dailyTokenCount);
        showError("Límite diario de " + MAX_TOKENS_DAILY + " tokens alcanzado.");
        return;
    }
    try {
        const token = localStorage.getItem('sessionToken');
        if (!token) {
            showError("Sesión no válida. Por favor, inicia sesión nuevamente.");
            completeLogout();
            return;
        }
        const response = await fetch(`/api/flights`);
        console.log("Respuesta de /api/flights:", response.status, response.statusText);
        if (response.ok) {
            const data = await response.json();
            console.log("Datos de /api/flights:", JSON.stringify(data, null, 2));
            flightData = Array.isArray(data.flights) ? data.flights.filter(f => f && f.flight_number) : [];
            console.log("flightData filtrado:", flightData);
            updateFlightInfo();
            updateMap();
            // Verificar anuncios de llegadas y despegues
            if (announcementsEnabled || departureAnnouncementsEnabled) {
                flightData.forEach(flight => {
                    if (flight.status === 'Landed' && flight.destination === 'SABE' && announcementsEnabled) {
                        announceFlight(flight, 'llegada');
                    } else if (flight.status === 'Departed' && flight.origin === 'SABE' && departureAnnouncementsEnabled) {
                        announceFlight(flight, 'despegue');
                    }
                });
            }
        } else if (response.status === 401) {
            showError("Sesión expirada. Por favor, inicia sesión nuevamente.");
            completeLogout();
        } else {
            throw new Error(`Error ${response.status}: ${response.statusText}`);
        }
    } catch (err) {
        showError("Error al cargar datos de vuelos: " + err.message);
        console.error("Error al cargar vuelos:", err);
        const tables = ['departures-table', 'arrivals-table', 'group-departures-table', 'group-arrivals-table'];
        tables.forEach(id => {
            const table = document.getElementById(id);
            if (table) {
                const tbody = table.querySelector('tbody') || table;
                tbody.innerHTML = "<tr><td colspan='9' class='text-center py-4 text-slate-500'>Error al cargar datos</td></tr>";
            }
        });
    }
    setTimeout(updateOpenSkyData, 15000);
}

function announceFlight(flight, type) {
    const message = type === 'llegada' 
        ? `El vuelo ${flight.flight_number} con origen en ${AIRPORT_MAPPING[flight.origin] || flight.origin} ha aterrizado en Aeroparque.`
        : `El vuelo ${flight.flight_number} con destino a ${AIRPORT_MAPPING[flight.destination] || flight.destination} ha despegado de Aeroparque.`;
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(message);
        utterance.lang = 'es-ES';
        speechSynthesis.speak(utterance);
    }
    showNotification('Anuncio de Vuelo', { body: message });
}

function initMap() {
    console.log("Inicializando mapa...");
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado");
        showError("No se puede cargar el mapa: contenedor no encontrado.");
        return;
    }
    if (typeof L === 'undefined') {
        console.error("Leaflet no está definido");
        showError("Error al cargar el mapa: Leaflet no disponible.");
        return;
    }
    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        }).addTo(map);
        const aeroparqueIcon = L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30]
        });
        L.marker([-34.5597, -58.4116], { icon: aeroparqueIcon })
            .addTo(map)
            .bindPopup("Aeroparque");
        map.invalidateSize();
        console.log("Mapa inicializado");
    } catch (err) {
        console.error("Error al inicializar Leaflet:", err);
        showError("Error al inicializar el mapa.");
    }
}

function updateMap() {
    if (!map) {
        console.warn("Mapa no inicializado. Intentando inicializar...");
        initMap();
        if (!map) return;
    }
    console.log("Actualizando mapa con flightData:", flightData);
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    const validFlights = flightData.filter(f => f && f.lat && f.lon && f.flight_number && isTargetAirline(f.flight_number));
    console.log("Vuelos válidos para el mapa:", validFlights);
    validFlights.forEach(flight => {
        try {
            const airplaneIcon = L.icon({
                iconUrl: '/templates/airplane.png',
                iconSize: [30, 30],
                iconAnchor: [15, 15],
                popupAnchor: [0, -15]
            });
            const marker = L.marker([flight.lat, flight.lon], {
                icon: airplaneIcon,
                rotationAngle: flight.heading || 0
            }).bindPopup(`
                <b>Vuelo:</b> ${flight.flight_number}<br>
                <b>Matrícula:</b> ${flight.registration || 'N/A'}<br>
                <b>Estado:</b> ${flight.status || 'N/A'}<br>
                <b>Origen:</b> ${AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A'}<br>
                <b>Destino:</b> ${AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A'}<br>
                <b>ETA:</b> ${flight.eta ? new Date(flight.eta).toLocaleTimeString() : 'N/A'}
            `);
            marker.flight = flight;
            markers.push(marker);
            marker.addTo(map);
        } catch (err) {
            console.error("Error al agregar marcador para vuelo:", flight, err);
        }
    });
    filterFlights(localStorage.getItem('lastSearchQuery') || '');
    map.invalidateSize();
    console.log("Mapa actualizado con", markers.length, "marcadores");
}

function updateFlightInfo() {
    console.log("Actualizando tablas con flightData:", flightData);
    // Accept both ICAO (SABE) and IATA (AEP) codes for Aeroparque
    const isAeroparque = (code) => code === 'SABE' || code === 'AEP';
    const tables = {
        'departures-table': { filter: f => isAeroparque(f.origin), isArrival: false },
        'arrivals-table': { filter: f => isAeroparque(f.destination), isArrival: true },
        'group-departures-table': { filter: f => isAeroparque(f.origin), isArrival: false },
        'group-arrivals-table': { filter: f => isAeroparque(f.destination), isArrival: true }
    };
    Object.entries(tables).forEach(([id, { filter, isArrival }]) => {
        const table = document.getElementById(id);
        if (!table) {
            console.error(`Tabla #${id} no encontrada`);
            return;
        }
        const tbody = table.querySelector('tbody') || table;
        tbody.innerHTML = '';
        const flights = flightData.filter(f => f && f.flight_number && isTargetAirline(f.flight_number) && filter(f));
        console.log(`Vuelos para ${id}:`, flights);
        flights.forEach(flight => {
            const row = document.createElement('tr');
            row.className = 'tams-row border-b border-slate-800 hover:bg-slate-900/40 transition duration-150';
            const sta = flight.sta ? (flight.sta.includes('/') ? flight.sta.split(' ')[1] : flight.sta) : 'N/A';
            const eta = (flight.eta && flight.eta !== 'N/A') ? (flight.eta.includes('/') ? flight.eta.split(' ')[1] : flight.eta) : 'N/A';
            const originDest = isArrival ? (AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A') : (AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A');
            
            const targetTime = getFlightTargetTime(flight);
            const targetMs = targetTime ? targetTime.getTime() : '';
            const flightNum = flight.flight_number || 'Unknown';
            const bellEnabled = bellAlerts.has(flightNum);
            const bellClass = bellEnabled ? 'text-amber-400' : 'text-slate-600';
            const bellTitle = bellEnabled ? 'Desactivar alerta' : 'Activar alerta';
            
            // Aircraft type and PAX
            const acType = flight.aircraft_type || 'N/A';
            const pax = PAX_LOOKUP[acType] ? `~${PAX_LOOKUP[acType]}` : 'N/A';
            
            row.innerHTML = `
                <td class="px-3 py-2.5 text-slate-200 font-mono text-xs">${flight.registration || 'N/A'}</td>
                <td class="px-3 py-2.5 text-slate-100 font-bold text-xs">
                    <div class="flex items-center gap-1">${getAirlineLogoHtml(flightNum)}<span>${flightNum}</span></div>
                </td>
                <td class="px-3 py-2.5 text-slate-300 text-xs font-mono">${sta}</td>
                <td class="px-3 py-2.5 text-slate-100 text-xs"><span class="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-semibold border border-slate-700">${flight.position || 'N/A'}</span></td>
                <td class="px-3 py-2.5 text-slate-300 text-xs">${originDest}</td>
                <td class="px-3 py-2.5 text-slate-300 text-xs font-mono">${eta}</td>
                <td class="px-3 py-2.5 text-xs">
                    <div class="flex items-center gap-1.5">
                        <span class="font-mono text-[10px] bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-sky-300" title="Tipo aeronave">${acType}</span>
                        <span class="font-mono text-[10px] text-slate-400" title="Pasajeros aprox.">${pax} pax</span>
                    </div>
                </td>
                <td class="px-3 py-2.5 text-xs flight-countdown-cell" data-target-ms="${targetMs}" data-flight-number="${flightNum}">
                    <div class="flex items-center gap-1.5">
                        <span class="countdown-text font-mono text-slate-400">...</span>
                        <button class="bell-btn text-base ${bellClass} hover:scale-110 transition-transform" title="${bellTitle}">🔔</button>
                    </div>
                </td>
                <td class="px-3 py-2.5 text-xs"><button class="tams-details-btn px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-[10px] font-medium transition duration-200">Info</button></td>
            `;
            const btn = row.querySelector('.tams-details-btn');
            btn.addEventListener('click', () => showFlightDetails(flight));
            // Per-flight bell toggle
            const bellBtn = row.querySelector('.bell-btn');
            bellBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (bellAlerts.has(flightNum)) {
                    bellAlerts.delete(flightNum);
                    firedBellAlerts.delete(flightNum); // Allow re-firing if re-enabled
                    bellBtn.classList.remove('text-amber-400');
                    bellBtn.classList.add('text-slate-600');
                    bellBtn.title = 'Activar alerta';
                } else {
                    bellAlerts.add(flightNum);
                    bellBtn.classList.add('text-amber-400');
                    bellBtn.classList.remove('text-slate-600');
                    bellBtn.title = 'Desactivar alerta';
                }
            });
            tbody.appendChild(row);
        });
    });
    filterFlights(localStorage.getItem('lastSearchQuery') || '');
}

function filterFlights(searchTerm = '') {
    searchTerm = searchTerm.toUpperCase().trim();
    const airlineFilter = document.getElementById('airline-filter')?.value || 'ALL';
    console.log("Filtrando vuelos con término:", searchTerm, "y aerolínea:", airlineFilter);
    
    const tables = ['departures-table', 'arrivals-table', 'group-departures-table', 'group-arrivals-table'];
    tables.forEach(id => {
        const table = document.getElementById(id);
        if (!table) return;
        const rows = table.querySelectorAll('tr.tams-row');
        rows.forEach(row => {
            const registration = row.cells[0].textContent.toUpperCase();
            const flightNumber = row.cells[1].textContent.toUpperCase();
            
            // Match search text term
            const textMatches = searchTerm === '' || registration.includes(searchTerm) || flightNumber.includes(searchTerm);
            
            // Match selected airline filter
            let airlineMatches = true;
            if (airlineFilter === 'AR') {
                airlineMatches = flightNumber.startsWith('AR') || flightNumber.startsWith('ARG');
            } else if (airlineFilter === 'LA') {
                const latamPrefixes = ['LA', 'LAN', 'JJ', 'TAM', 'LP', 'LPE', 'XL', 'LNE', '4M', 'DSM', 'LAP'];
                airlineMatches = latamPrefixes.some(pref => flightNumber.startsWith(pref));
            } else if (airlineFilter === 'FO') {
                airlineMatches = flightNumber.startsWith('FO') || flightNumber.startsWith('FB');
            } else if (airlineFilter === 'WJ') {
                airlineMatches = flightNumber.startsWith('WJ');
            } else if (airlineFilter === 'G3') {
                airlineMatches = flightNumber.startsWith('G3') || flightNumber.startsWith('GLO');
            }
            
            row.style.display = (textMatches && airlineMatches) ? '' : 'none';
        });
    });
    if (map) {
        markers.forEach(marker => {
            const flight = marker.flight || {};
            const registration = flight.registration || '';
            const flightNumber = (flight.flight_number || '').toUpperCase();
            
            const textMatches = searchTerm === '' || registration.toUpperCase().includes(searchTerm) || flightNumber.includes(searchTerm);
            
            let airlineMatches = true;
            if (airlineFilter === 'AR') {
                airlineMatches = flightNumber.startsWith('AR') || flightNumber.startsWith('ARG');
            } else if (airlineFilter === 'LA') {
                const latamPrefixes = ['LA', 'LAN', 'JJ', 'TAM', 'LP', 'LPE', 'XL', 'LNE', '4M', 'DSM', 'LAP'];
                airlineMatches = latamPrefixes.some(pref => flightNumber.startsWith(pref));
            } else if (airlineFilter === 'FO') {
                airlineMatches = flightNumber.startsWith('FO') || flightNumber.startsWith('FB');
            } else if (airlineFilter === 'WJ') {
                airlineMatches = flightNumber.startsWith('WJ');
            } else if (airlineFilter === 'G3') {
                airlineMatches = flightNumber.startsWith('G3') || flightNumber.startsWith('GLO');
            }
            
            if (textMatches && airlineMatches) {
                if (!map.hasLayer(marker)) marker.addTo(map);
            } else {
                if (map.hasLayer(marker)) map.removeLayer(marker);
            }
        });
        map.invalidateSize();
    }
}

function toggleUpdates() {
    const updatesToggleBtn = document.getElementById('updates-toggle');
    if (!updatesToggleBtn) {
        console.error("Botón #updates-toggle no encontrado");
        return;
    }
    updatesEnabled = !updatesEnabled;
    updatesToggleBtn.classList.toggle('active', updatesEnabled);
    updatesToggleBtn.textContent = updatesEnabled ? 'Pausar Actualizaciones' : 'Reanudar Actualizaciones';
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'toggle_updates', enabled: updatesEnabled }));
    }
    console.log("Actualizaciones de vuelos:", updatesEnabled ? "activadas" : "pausadas");
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    if (!swipeHint) return;
    swipeHint.textContent = currentGroup 
        ? 'Desliza hacia la derecha para ver el grupo' 
        : 'Desliza hacia la izquierda para volver al grupo';
}

function returnToGroup() {
    if (currentGroup) {
        document.getElementById('main').classList.add('slide-left');
        setTimeout(() => {
            document.getElementById('main').style.display = 'none';
            document.getElementById('group-screen').style.display = 'block';
            document.getElementById('main').classList.remove('slide-left');
            updateSwipeHint();
        }, 300);
    }
}

document.addEventListener('touchstart', (e) => {
    if (!currentGroup) return;
    isSwiping = true;
    startX = e.touches[0].clientX;
    currentX = startX;
});

document.addEventListener('touchmove', (e) => {
    if (!isSwiping || !currentGroup) return;
    currentX = e.touches[0].clientX;
    const diffX = startX - currentX;
    const main = document.getElementById('main');
    const groupScreen = document.getElementById('group-screen');
    if (diffX > 0 && main.style.display === 'block') {
        main.style.transform = `translateX(-${diffX}px)`;
    } else if (diffX < 0 && groupScreen.style.display === 'block') {
        groupScreen.style.transform = `translateX(${-diffX}px)`;
    }
});

document.addEventListener('touchend', () => {
    if (!isSwiping || !currentGroup) return;
    isSwiping = false;
    const diffX = startX - currentX;
    const threshold = window.innerWidth / 4;
    const main = document.getElementById('main');
    const groupScreen = document.getElementById('group-screen');
    if (diffX > threshold && main.style.display === 'block') {
        main.classList.add('slide-left');
        setTimeout(() => {
            main.style.display = 'none';
            main.style.transform = '';
            main.classList.remove('slide-left');
            groupScreen.style.display = 'block';
            groupScreen.style.transform = '';
            updateSwipeHint();
        }, 300);
    } else if (diffX < -threshold && groupScreen.style.display === 'block') {
        groupScreen.classList.add('slide-right');
        setTimeout(() => {
            groupScreen.style.display = 'none';
            groupScreen.style.transform = '';
            groupScreen.classList.remove('slide-right');
            main.style.display = 'block';
            main.style.transform = '';
            updateSwipeHint();
        }, 300);
    } else {
        main.style.transform = '';
        groupScreen.style.transform = '';
    }
});

function checkNotificationPermission() {
    if (!('Notification' in window)) {
        console.warn("Notificaciones no soportadas");
        return;
    }
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            console.log("Permiso de notificaciones:", permission);
        });
    }
}

function showNotification(title, options) {
    if (!('Notification' in window)) {
        console.warn("Notificaciones no soportadas");
        return;
    }
    if (Notification.permission === 'granted') {
        new Notification(title, options);
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                new Notification(title, options);
            }
        });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('Service Worker registrado:', registration.scope);
            
            // Check for updates periodically (every 15 seconds)
            setInterval(() => {
                registration.update();
            }, 15000);

            // Handle updates
            const showUpdateBanner = (worker) => {
                const updateBanner = document.getElementById('app-update-banner');
                const updateBtn = document.getElementById('app-update-btn');
                if (updateBanner) {
                    updateBanner.classList.remove('hidden');
                    updateBanner.classList.add('flex');
                }
                if (updateBtn && worker) {
                    updateBtn.onclick = () => {
                        worker.postMessage({ type: 'SKIP_WAITING' });
                    };
                }
            };

            // If there's already a waiting worker, show the update banner immediately
            if (registration.waiting) {
                showUpdateBanner(registration.waiting);
            }

            registration.onupdatefound = () => {
                const installingWorker = registration.installing;
                if (installingWorker) {
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed') {
                            if (navigator.serviceWorker.controller) {
                                console.log('Nuevo contenido disponible en segundo plano.');
                                showUpdateBanner(installingWorker);
                            }
                        }
                    };
                }
            };
        }).catch(error => {
            console.error('Error al registrar Service Worker:', error);
        });

        // Reload the page when the active service worker changes
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                console.log('Service Worker actualizado. Recargando página...');
                window.location.reload();
            }
        });
    } else {
        console.warn("Service Worker no soportado");
    }
}

function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'logout', sessionToken: localStorage.getItem('sessionToken') }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('userName');
    localStorage.removeItem('userFunction');
    localStorage.removeItem('userLegajo');
    localStorage.removeItem('groupId');
    localStorage.removeItem('lastSearchQuery');
    userId = null;
    currentGroup = null;
    if (ws) {
        ws.close();
        ws = null;
    }
    stopPing();
    document.getElementById('main').style.display = 'none';
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('auth-section').style.display = 'block';
    
    // Always default to registration form when logging out or clearing session
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    
    displayUserProfile();
    updateSwipeHint();
    showError('Sesión cerrada exitosamente', true);
}

function base64ToBlob(base64, mime) {
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([arrayBuffer], { type: mime });
    } catch (err) {
        console.error("Error al convertir base64 a Blob:", err);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    localStorage.removeItem('lastSearchQuery');
    filterFlights('');
    document.getElementById('register-form')?.addEventListener('submit', registerUser);
    document.getElementById('login-form')?.addEventListener('submit', loginUser);
    document.getElementById('show-login')?.addEventListener('click', () => {
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
    });
    document.getElementById('show-register')?.addEventListener('click', () => {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
    });
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.addEventListener('click', logout);
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (returnToGroupBtn) returnToGroupBtn.addEventListener('click', returnToGroup);
    const talkButton = document.getElementById('talk');
    if (talkButton) {
        // Detect if device supports touch events (mobile/tablet)
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        
        if (isTouchDevice) {
            console.log("Device is mobile/touch. Enabling press-and-hold touch actions.");
            talkButton.addEventListener('touchstart', (e) => {
                e.preventDefault();
                toggleTalk(true);
            });
            talkButton.addEventListener('touchend', (e) => {
                e.preventDefault();
                toggleTalk(false);
            });
            talkButton.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                toggleTalk(false);
            });
        } else {
            console.log("Device is desktop. Enabling default click toggle action.");
            talkButton.addEventListener('click', () => {
                toggleTalk();
            });
        }
    }
    const groupTalkButton = document.getElementById('group-talk');
    if (groupTalkButton) {
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (isTouchDevice) {
            groupTalkButton.addEventListener('touchstart', (e) => {
                e.preventDefault();
                toggleGroupTalk(true);
            });
            groupTalkButton.addEventListener('touchend', (e) => {
                e.preventDefault();
                toggleGroupTalk(false);
            });
            groupTalkButton.addEventListener('touchcancel', (e) => {
                e.preventDefault();
                toggleGroupTalk(false);
            });
        } else {
            groupTalkButton.addEventListener('click', () => {
                toggleGroupTalk();
            });
        }
    }
    const muteButton = document.getElementById('mute');
    if (muteButton) muteButton.addEventListener('click', toggleMute);
    const groupMuteButton = document.getElementById('group-mute');
    if (groupMuteButton) groupMuteButton.addEventListener('click', toggleGroupMute);
    const muteNonGroupButton = document.getElementById('mute-non-group');
    if (muteNonGroupButton) muteNonGroupButton.addEventListener('click', toggleMuteNonGroup);
    const joinGroupBtn = document.getElementById('join-group-btn');
    if (joinGroupBtn) joinGroupBtn.addEventListener('click', joinGroup);

    // Native PWA Installation Handler
    let deferredPrompt = null;
    const installContainer = document.getElementById('pwa-install-container');
    const installBtn = document.getElementById('pwa-install-btn');

    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent Chrome 67 and earlier from automatically showing the prompt
        e.preventDefault();
        // Stash the event so it can be triggered later.
        deferredPrompt = e;
        // Update UI notify the user they can install the PWA
        if (installContainer) {
            installContainer.classList.remove('hidden');
        }
    });

    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            // Show the install prompt
            deferredPrompt.prompt();
            // Wait for the user to respond to the prompt
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`PWA install choice outcome: ${outcome}`);
            // We've used the prompt, and can't use it again
            deferredPrompt = null;
            // Hide the install button
            if (installContainer) {
                installContainer.classList.add('hidden');
            }
        });
    }

    window.addEventListener('appinstalled', () => {
        console.log('HANDLEPHONE PWA fue instalada correctamente');
        if (installContainer) {
            installContainer.classList.add('hidden');
        }
    });
    const createGroupBtn = document.getElementById('create-group-btn');
    if (createGroupBtn) createGroupBtn.addEventListener('click', createGroup);
    const leaveGroupBtn = document.getElementById('leave-group-btn');
    if (leaveGroupBtn) leaveGroupBtn.addEventListener('click', leaveGroup);
    const radarBtn = document.getElementById('radar');
    if (radarBtn) radarBtn.addEventListener('click', showRadar);
    const groupRadarBtn = document.getElementById('group-radar');
    if (groupRadarBtn) groupRadarBtn.addEventListener('click', showGroupRadar);
    const historyBtn = document.getElementById('history');
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    const groupHistoryBtn = document.getElementById('group-history');
    if (groupHistoryBtn) groupHistoryBtn.addEventListener('click', showGroupHistory);
    const backToMainBtn = document.getElementById('back-to-main');
    if (backToMainBtn) backToMainBtn.addEventListener('click', backToMainFromGroup);
    const radarCloseBtn = document.querySelector('#radar-screen .close-btn');
    if (radarCloseBtn) radarCloseBtn.addEventListener('click', backToMainFromRadar);
    
    // Bindings de modal close e historial back agregados para solucionar fallas de navegación originales
    document.getElementById('close-modal-btn')?.addEventListener('click', closeFlightDetails);
    document.getElementById('close-modal-footer-btn')?.addEventListener('click', closeFlightDetails);
    document.getElementById('history-back-btn')?.addEventListener('click', backToMainFromHistory);
    const updatesToggleBtn = document.getElementById('updates-toggle');
    if (updatesToggleBtn) updatesToggleBtn.addEventListener('click', toggleUpdates);
    const toggleAnnouncementsBtn = document.getElementById('toggle-announcements');
    if (toggleAnnouncementsBtn) {
        toggleAnnouncementsBtn.addEventListener('click', () => {
            announcementsEnabled = !announcementsEnabled;
            toggleAnnouncementsBtn.textContent = announcementsEnabled ? 'Desactivar anuncios de llegadas' : 'Activar anuncios de llegadas';
            console.log("Anuncios de llegadas:", announcementsEnabled ? "activados" : "desactivados");
        });
    }
    const toggleDepartureAnnouncementsBtn = document.getElementById('toggle-departure-announcements');
    if (toggleDepartureAnnouncementsBtn) {
        toggleDepartureAnnouncementsBtn.addEventListener('click', () => {
            departureAnnouncementsEnabled = !departureAnnouncementsEnabled;
            toggleDepartureAnnouncementsBtn.textContent = departureAnnouncementsEnabled ? 'Desactivar anuncios de despegues' : 'Activar anuncios de despegues';
            console.log("Anuncios de despegues:", departureAnnouncementsEnabled ? "activados" : "desactivados");
        });
    }
    const toggleTokenLimitBtn = document.getElementById('toggle-token-limit');
    if (toggleTokenLimitBtn) {
        toggleTokenLimitBtn.textContent = restrictTokens ? 'Desactivar límite de tokens' : 'Activar límite de tokens';
        toggleTokenLimitBtn.addEventListener('click', () => {
            restrictTokens = !restrictTokens;
            localStorage.setItem('restrictTokens', JSON.stringify(restrictTokens));
            toggleTokenLimitBtn.textContent = restrictTokens ? 'Desactivar límite de tokens' : 'Activar límite de tokens';
            console.log("Límite de tokens:", restrictTokens ? "activado" : "desactivado");
        });
    }
    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', () => {
            const searchTerm = document.getElementById('search-input')?.value || '';
            localStorage.setItem('lastSearchQuery', searchTerm);
            filterFlights(searchTerm);
        });
    }
    const airlineFilterSelect = document.getElementById('airline-filter');
    if (airlineFilterSelect) {
        airlineFilterSelect.addEventListener('change', () => {
            const searchTerm = document.getElementById('search-input')?.value || '';
            filterFlights(searchTerm);
        });
    }
    checkNotificationPermission();
    checkMicrophonePermission();
    registerServiceWorker();
    initMap();
    setInterval(updateCountdowns, 1000);

    // Check and request microphone permission banner logic
    function checkMicrophonePermission() {
        const permissionBanner = document.getElementById('mic-permission-banner');
        const yesBtn = document.getElementById('mic-perm-yes');
        const noBtn = document.getElementById('mic-perm-no');
        
        if (!permissionBanner) return;

        // If standard mediaDevices query is supported
        if (navigator.permissions && navigator.permissions.query) {
            navigator.permissions.query({ name: 'microphone' }).then((permissionStatus) => {
                console.log('Estado actual del permiso de micrófono:', permissionStatus.state);
                if (permissionStatus.state !== 'granted') {
                    permissionBanner.classList.remove('hidden');
                    permissionBanner.classList.add('flex');
                }
                permissionStatus.onchange = () => {
                    if (permissionStatus.state === 'granted') {
                        permissionBanner.classList.add('hidden');
                        permissionBanner.classList.remove('flex');
                    }
                };
            }).catch(() => {
                // Fallback: check if we've saved that they rejected it
                if (localStorage.getItem('mic_permission_declined') !== 'true') {
                    permissionBanner.classList.remove('hidden');
                    permissionBanner.classList.add('flex');
                }
            });
        } else {
            // Fallback for older browsers / iOS webviews
            if (localStorage.getItem('mic_permission_declined') !== 'true') {
                permissionBanner.classList.remove('hidden');
                permissionBanner.classList.add('flex');
            }
        }

        if (yesBtn) {
            yesBtn.onclick = () => {
                // Request microphone access from standard browser prompt
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then((stream) => {
                        console.log('Permiso concedido exitosamente.');
                        // Stop track immediately to release the red recording dot
                        stream.getTracks().forEach(track => track.stop());
                        permissionBanner.classList.add('hidden');
                        permissionBanner.classList.remove('flex');
                        localStorage.removeItem('mic_permission_declined');
                    })
                    .catch((err) => {
                        console.error('Permiso rechazado en prompt:', err);
                        showError('Permiso denegado. Debes habilitar el micrófono desde la barra de direcciones.');
                    });
            };
        }

        if (noBtn) {
            noBtn.onclick = () => {
                permissionBanner.classList.add('hidden');
                permissionBanner.classList.remove('flex');
                localStorage.setItem('mic_permission_declined', 'true');
            };
        }
    }
    
    // AUTO-LOGIN: restore session from localStorage if token exists
    const savedToken = localStorage.getItem('sessionToken');
    const savedName = localStorage.getItem('userName');
    const savedFunction = localStorage.getItem('userFunction');
    const savedLegajo = localStorage.getItem('userLegajo');
    const isRegistered = localStorage.getItem('isRegistered');
    
    if (savedToken && savedName) {
        try {
            userId = `${savedLegajo}_${savedName}_${savedFunction}`;
            connectWebSocket(savedToken);
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            displayUserProfile();
            updateOpenSkyData();
        } catch (e) {
            console.warn('Auto-login failed, clearing session:', e);
            localStorage.clear();
        }
    } else if (isRegistered === 'true') {
        // If they registered once, direct them to login rather than register form
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
    }
    
    // SVG Icons for buttons
    const talkBtn = document.getElementById('talk');
    if (talkBtn) {
        talkBtn.innerHTML = `<div class="w-24 h-24 rounded-full bg-gradient-to-b from-sky-600 to-sky-800 hover:from-sky-500 hover:to-sky-700 active:scale-95 border-4 border-sky-400/40 shadow-lg shadow-sky-900/50 flex items-center justify-center transition-all">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V21h2v-2.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
        </div>`;
        talkBtn.classList.add('block');
    }
    const muteBtn = document.getElementById('mute');
    if (muteBtn) {
        muteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-slate-350" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
    }
    const logoutBtn = document.getElementById('logout-button');
    if (logoutBtn) {
        logoutBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg> Salir`;
        logoutBtn.className = logoutBtn.className + ' flex items-center gap-2';
    }

    // Keyboard Spacebar Push-To-Talk Bindings
    let spacePressed = false;
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            // Avoid triggering push-to-talk if user is currently typing inside input/select fields
            const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            if (activeTag === 'input' || activeTag === 'select' || activeTag === 'textarea') {
                return;
            }
            e.preventDefault();
            if (!spacePressed) {
                spacePressed = true;
                console.log("PTT: Barra espaciadora presionada -> Iniciando grabación");
                toggleTalk(true);
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            if (activeTag === 'input' || activeTag === 'select' || activeTag === 'textarea') {
                return;
            }
            e.preventDefault();
            if (spacePressed) {
                spacePressed = false;
                console.log("PTT: Barra espaciadora soltada -> Deteniendo grabación");
                toggleTalk(false);
            }
        }
    });

    // PWA Widget communication listener
    navigator.serviceWorker?.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'PTT_WIDGET_START') {
            console.log('PTT triggered from PWA widget shortcut');
            toggleTalk(true);
            setTimeout(() => toggleTalk(false), 5000); // Record 5s default if triggered remotely
        }
    });

    // Handle hash launcher shortcuts
    if (window.location.hash === '#ptt-shortcut' || window.location.hash === '#ptt-widget-action') {
        history.replaceState(null, null, ' '); // Clean URL
        setTimeout(() => {
            console.log('Launching shortcut mic action...');
            toggleTalk(true);
            setTimeout(() => toggleTalk(false), 6000); // 6 seconds recording limit
        }, 1000);
    }
});

const style = document.createElement('style');
style.textContent = `
    .slide-left {
        transition: transform 0.3s ease-out;
        transform: translateX(-100%);
    }
    .slide-right {
        transition: transform 0.3s ease-out;
        transform: translateX(100%);
    }
    .recording {
        background-color: red;
        color: white;
    }
    .muted {
        background-color: #ccc;
    }
    .unmuted {
        background-color: #4CAF50;
    }
    .user-item {
        display: flex;
        align-items: center;
        margin: 5px 0;
    }
    .mute-button {
        margin-right: 10px;
    }
    .chat-message {
        cursor: pointer;
        margin: 5px 0;
    }
    .play-icon {
        margin-right: 5px;
    }
    .in-group {
        font-weight: bold;
    }
    .tams-row {
        cursor: pointer;
    }
    .tams-details-btn {
        padding: 5px 10px;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    }
    .tams-details-btn:hover {
        background-color: #0056b3;
    }
    .toggle-btn {
        padding: 10px;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
    }
    .toggle-btn.active {
        background-color: #28a745;
    }
`;
document.head.appendChild(style);
