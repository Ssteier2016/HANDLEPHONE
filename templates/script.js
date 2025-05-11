// Variables globales
let ws = null;
let pingInterval = null;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = [];
let isPlaying = false;
let markers = [];
let recognition;
let supportsSpeechRecognition = false;
let mutedUsers = new Set();
let currentGroup = null;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let flightData = [];
let reconnectInterval = null;
let announcementsEnabled = false;
let announcedFlights = [];
let groupRecording = false;
let groupMediaRecorder = null;
let updatesEnabled = true; // Para el interruptor de actualizaciones
let dailyTokenCount = 0; // Para rastrear tokens de FlightRadar24
const PING_INTERVAL = 30000;
const RECONNECT_BASE_DELAY = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;
const SYNC_TAG = 'sync-messages';
const MAX_TOKENS_DAILY = 1000; // Límite de tokens de FlightRadar24
const TOKENS_PER_FLIGHT = 3; // 3 tokens por vuelo
const MAX_FLIGHTS_PER_REQUEST = 20; // Límite de vuelos por solicitud

const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Inicializar SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    supportsSpeechRecognition = true;
    console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
} else {
    console.warn("SpeechRecognition no soportado. Navegador:", navigator.userAgent);
    alert("Tu navegador no soporta speech-to-text en el cliente. El servidor transcribirá el audio.");
}

// Mostrar nombre del perfil
function displayUserProfile() {
    const sessionToken = localStorage.getItem('sessionToken');
    const profileDiv = document.getElementById('user-profile');
    if (sessionToken && profileDiv) {
        try {
            const decoded = atob(sessionToken);
            const [employee_id, surname, sector] = decoded.split('_');
            profileDiv.textContent = `Bienvenido, ${surname} (${employee_id}) - ${sector}`;
        } catch (error) {
            console.error('Error al decodificar token:', error);
            localStorage.removeItem('sessionToken');
            profileDiv.textContent = '';
        }
    } else if (profileDiv) {
        profileDiv.textContent = '';
    }
}

// Validar token con el servidor
async function validateToken(sessionToken) {
    try {
        const response = await fetch('/validate-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: sessionToken }),
        });
        if (response.ok) {
            console.log("Token válido");
            return true;
        } else if (response.status === 404) {
            console.warn("Endpoint /validate-token no encontrado. Continuando sin validación.");
            return true;
        } else {
            console.warn("Token inválido o expirado:", response.status, response.statusText);
            return false;
        }
    } catch (error) {
        console.error("Error al validar token:", error);
        return true;
    }
}

// Restaurar sesión al cargar la página
document.addEventListener('DOMContentLoaded', async () => {
    registerServiceWorker();
    displayUserProfile();
    const sessionToken = localStorage.getItem('sessionToken');
    const userName = localStorage.getItem('userName');
    const userFunction = localStorage.getItem('userFunction');
    const userLegajo = localStorage.getItem('userLegajo');

    let isAuthenticated = false;
    if (sessionToken && userName && userFunction && userLegajo) {
        isAuthenticated = await validateToken(sessionToken);
        if (isAuthenticated) {
            userId = `${userLegajo}_${userName}_${userFunction}`;
            connectWebSocket(sessionToken);
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            checkGroupStatus();
        } else {
            console.warn("Token inválido, mostrando pantalla de login");
            localStorage.removeItem('sessionToken');
            localStorage.removeItem('userName');
            localStorage.removeItem('userFunction');
            localStorage.removeItem('userLegajo');
            alert("Sesión inválida. Por favor, inicia sesión nuevamente.");
            document.getElementById('auth-section').style.display = 'block';
            document.getElementById('main').style.display = 'none';
        }
    } else {
        console.log("No hay sesión activa, mostrando pantalla de login");
        document.getElementById('auth-section').style.display = 'block';
        document.getElementById('main').style.display = 'none';
    }

    updateOpenSkyData();
    initMap(); // Inicializar el mapa al cargar

    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', sendSearchQuery);
    } else {
        console.error("Botón de búsqueda no encontrado en el DOM");
    }

    const registerForm = document.getElementById('register-form');
    const loginForm = document.getElementById('login-form');
    if (registerForm) {
        registerForm.addEventListener('submit', registerUser);
    } else {
        console.error("Formulario de registro no encontrado en el DOM");
    }
    if (loginForm) {
        loginForm.addEventListener('submit', loginUser);
    } else {
        console.error("Formulario de login no encontrado en el DOM");
    }

    const showLogin = document.getElementById('show-login');
    const showRegister = document.getElementById('show-register');
    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        });
    }
    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').style.display = 'block';
            document.getElementById('login-form').style.display = 'none';
        });
    }

    const toggleAnnouncementsBtn = document.getElementById('toggle-announcements');
    if (toggleAnnouncementsBtn) {
        toggleAnnouncementsBtn.addEventListener('click', () => {
            announcementsEnabled = !announcementsEnabled;
            toggleAnnouncementsBtn.textContent = announcementsEnabled ? 'Desactivar anuncios de vuelos' : 'Activar anuncios de vuelos';
            console.log("Anuncios de vuelos:", announcementsEnabled ? "activados" : "desactivados");
        });
    } else {
        console.error("Botón #toggle-announcements no encontrado");
    }

    const updatesToggleBtn = document.getElementById('updates-toggle');
    if (updatesToggleBtn) {
        updatesToggleBtn.addEventListener('click', () => {
            updatesEnabled = !updatesEnabled;
            updatesToggleBtn.classList.toggle('active', updatesEnabled);
            updatesToggleBtn.textContent = updatesEnabled ? 'Pausar Actualizaciones' : 'Reanudar Actualizaciones';
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'toggle_updates', enabled: updatesEnabled }));
            }
            console.log("Actualizaciones de vuelos:", updatesEnabled ? "activadas" : "pausadas");
        });
    } else {
        console.error("Botón #updates-toggle no encontrado");
    }

    checkNotificationPermission();
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'SEND_MESSAGE' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event.data.message));
            console.log('Mensaje sincronizado enviado:', event.data.message);
        } else if (event.data && event.data.type === 'SYNC_COMPLETE') {
            console.log('Sincronización completada');
        }
    });
});

// Manejar visibilidad de la pestaña
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('App en segundo plano');
    } else {
        console.log('App en primer plano');
        if (ws && ws.readyState !== WebSocket.OPEN) {
            const sessionToken = localStorage.getItem('sessionToken');
            if (sessionToken) {
                validateToken(sessionToken).then(isValid => {
                    if (isValid) {
                        connectWebSocket(sessionToken);
                    } else {
                        console.warn("Token inválido al intentar reconectar WebSocket");
                        localStorage.removeItem('sessionToken');
                    }
                });
            }
        }
    }
});

function queueMessageForSync(message) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'QUEUE_MESSAGE',
            message: message
        });
        console.log('Mensaje enviado al Service Worker para encolar');
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register(SYNC_TAG).catch(err => {
                console.error('Error al registrar sync:', err);
            });
        });
    } else {
        console.error('Service Worker no está disponible para encolar mensaje');
        alert('No se pudo guardar el mensaje. Por favor, verifica la conexión.');
    }
}

// Funciones de audio
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("Contexto de audio desbloqueado");
        }).catch(err => {
            console.error("Error al desbloquear el contexto de audio:", err);
        });
    }
}

async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar permiso de micrófono:", err);
        alert("No se pudo acceder al micrófono. Por favor, habilita los permisos.");
        return null;
    }
}

function playAudio(blob) {
    if (!blob || blob.size === 0) {
        console.error("Blob de audio inválido o vacío");
        return;
    }
    const audio = new Audio(URL.createObjectURL(blob));
    audioQueue.push(audio);
    playNextAudio();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaSessionMetadata({
            title: 'Mensaje de voz',
            artist: 'HANDLEPHONE',
            album: 'Comunicación Aeronáutica'
        });
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    }
}

function playNextAudio() {
    if (audioQueue.length === 0 || isPlaying) return;
    isPlaying = true;
    const audio = audioQueue.shift();
    audio.play().then(() => {
        console.log("Audio reproducido exitosamente");
        isPlaying = false;
        playNextAudio();
    }).catch(err => {
        console.error("Error reproduciendo audio:", err);
        isPlaying = false;
        playNextAudio();
    });
}

function playAnnouncement(audioUrl) {
    const audio = new Audio(audioUrl);
    audio.play().catch(error => {
        console.error('Error al reproducir anuncio:', error);
    });
}

// Funciones de búsqueda
function sendSearchQuery() {
    const query = document.getElementById('search-input').value.trim().toUpperCase();
    if (!query) {
        alert('Ingresá una consulta');
        return;
    }
    localStorage.setItem('lastSearchQuery', query);
    filterFlights(query); // Filtrar localmente
    document.getElementById('search-input').value = '';
    console.log(`Consulta de búsqueda: ${query}`);
}

function filterFlights(searchTerm = '') {
    searchTerm = searchTerm.toUpperCase().trim();
    console.log("Filtrando vuelos con término:", searchTerm);

    // Filtrar tablas
    const tables = [
        document.getElementById('departures-table'),
        document.getElementById('arrivals-table'),
        document.getElementById('group-departures-table'),
        document.getElementById('group-arrivals-table')
    ];

    tables.forEach(table => {
        if (!table) return;
        const rows = table.querySelectorAll('tr.tams-row');
        rows.forEach(row => {
            const registration = row.cells[0].textContent.toUpperCase();
            const flightNumber = row.cells[1].textContent.toUpperCase();
            const matches = searchTerm === '' ||
                           registration.includes(searchTerm) ||
                           flightNumber.includes(searchTerm);
            row.style.display = matches ? '' : 'none';
        });
    });

    // Filtrar marcadores en el mapa
    markers.forEach(marker => {
        const flight = marker.flight || {};
        const registration = flight.registration || '';
        const flightNumber = flight.flight_number || '';
        const matches = searchTerm === '' ||
                       registration.toUpperCase().includes(searchTerm) ||
                       flightNumber.toUpperCase().includes(searchTerm);
        if (matches) {
            if (!map.hasLayer(marker)) {
                marker.addTo(map);
            }
        } else {
            if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        }
    });

    if (map) map.invalidateSize();
    console.log("Vuelos filtrados, marcadores actualizados:", markers.length);
}

// Funciones de registro y conexión
async function registerUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname').value.trim();
    const employee_id = document.getElementById('employee_id').value.trim();
    const sector = document.getElementById('sector').value;
    const password = document.getElementById('password').value;

    console.log("Intentando registrar:", { surname, employee_id, sector });

    if (!surname || !employee_id || !sector || !password) {
        alert('Por favor, completa todos los campos.');
        return;
    }
    if (!/^\d{5}$/.test(employee_id)) {
        alert('El legajo debe contener exactamente 5 números.');
        return;
    }
    if (password.length < 6) {
        alert('La contraseña debe tener al menos 6 caracteres.');
        return;
    }

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, sector, password }),
        });
        const data = await response.json();
        if (response.ok) {
            alert('Registro exitoso. Por favor, inicia sesión.');
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        } else {
            const errorMessage = data.detail && typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
            alert(`Error al registrar: ${errorMessage}`);
            console.error('Error en registro:', data);
        }
    } catch (error) {
        console.error('Error al registrar:', error);
        alert('Error de conexión con el servidor. Intenta de nuevo.');
    }
}

async function loginUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname-login').value.trim();
    const employee_id = document.getElementById('employee_id-login').value.trim();
    const password = document.getElementById('password-login').value;

    console.log("Intentando login con:", { surname, employee_id });

    if (!surname || !employee_id || !password) {
        alert('Por favor, completa todos los campos.');
        return;
    }
    if (!/^\d{5}$/.test(employee_id)) {
        alert('El legajo debe contener exactamente 5 números.');
        return;
    }

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, password }),
        });
        const data = await response.json();
        if (response.ok) {
            localStorage.setItem('sessionToken', data.token);
            const decoded = atob(data.token);
            const [employee_id, surname, sector] = decoded.split('_');
            localStorage.setItem('userName', surname);
            localStorage.setItem('userFunction', sector);
            localStorage.setItem('userLegajo', employee_id);
            userId = `${employee_id}_${surname}_${sector}`;
            connectWebSocket(data.token);
            alert('Inicio de sesión exitoso');
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            displayUserProfile();
            updateOpenSkyData();
        } else {
            const errorMessage = data.detail && typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
            alert(`Error al iniciar sesión: ${errorMessage}`);
            console.error('Error en login:', data);
        }
    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        alert('Error de conexión con el servidor. Intenta de nuevo.');
    }
}

// Conectar WebSocket
function connectWebSocket(sessionToken, retryCount = 0) {
    if (!sessionToken) {
        console.warn("No hay sessionToken, pero continuando para mostrar vuelos");
        updateOpenSkyData();
        return;
    }
    const wsUrl = `wss://${window.location.host}/ws/${encodeURIComponent(sessionToken)}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl} (Intento ${retryCount + 1})`);
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        updateOpenSkyData();
        return;
    }

    ws.onopen = function() {
        console.log("WebSocket conectado exitosamente");
        clearInterval(reconnectInterval);
        ws.send(JSON.stringify({
            type: "register",
            legajo: localStorage.getItem("userLegajo"),
            name: localStorage.getItem("userName"),
            function: localStorage.getItem("userFunction")
        }));
        document.getElementById("auth-section").style.display = "none";
        const mainDiv = document.getElementById("main");
        if (mainDiv) {
            mainDiv.style.display = "block";
        } else {
            console.error("Elemento #main no encontrado en el DOM");
        }
        updateUsers(0, []);
        updateOpenSkyData();
        startPing();
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(registration => {
                registration.sync.register(SYNC_TAG).catch(err => {
                    console.error('Error al registrar sync al reconectar:', err);
                });
            });
        }
    };

    ws.onmessage = function(event) {
        console.log("Datos recibidos del servidor:", event.data);
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje parseado:", message);

            if (!message.type) {
                console.error("Mensaje sin tipo:", message);
                return;
            }

            if (message.type === "audio" || message.type === "group_message") {
                if (!message.data) {
                    console.error("Mensaje de audio sin datos de audio:", message);
                    return;
                }
                const senderId = `${message.sender}_${message.function}`;
                if (mutedUsers.has(senderId)) {
                    console.log(`Mensaje de ${senderId} ignorado porque está muteado`);
                    return;
                }
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                if (!audioBlob) {
                    console.error("No se pudo crear el Blob para el mensaje de audio");
                    return;
                }
                playAudio(audioBlob);
                const chatListId = message.type === "group_message" ? "group-chat-list" : "chat-list";
                const chatList = document.getElementById(chatListId);
                if (!chatList) {
                    console.error(`Elemento ${chatListId} no encontrado en el DOM`);
                    return;
                }
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const timestamp = message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = message.sender || "Anónimo";
                const userFunction = message.function || "Desconocida";
                const text = message.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${text}`;
                msgDiv.onclick = () => playAudio(audioBlob);
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
                console.log(`Mensaje de ${message.type} agregado al ${chatListId}`);
            } else if (message.type === "users") {
                updateUsers(message.count, message.list);
            } else if (message.type === "mute_all_success") {
                updateMuteButton(true);
                console.log("Muteo global activado");
            } else if (message.type === "unmute_all_success") {
                updateMuteButton(false);
                console.log("Muteo global desactivado");
            } else if (message.type === "mute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.add(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.add("muted");
                document.getElementById("mute-non-group").textContent = "Desmutear no grupo";
                console.log("Usuarios fuera del grupo muteados");
            } else if (message.type === "unmute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.delete(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.remove("muted");
                document.getElementById("mute-non-group").textContent = "Mutear no grupo";
                console.log("Usuarios fuera del grupo desmuteados");
            } else if (message.type === "group_joined") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                if (message.is_private) {
                    const logoutButton = document.getElementById('logout-button');
                    if (logoutButton) logoutButton.style.display = 'none';
                }
                updateSwipeHint();
                console.log(`Unido al grupo: ${message.group_id}, privado: ${message.is_private}`);
            } else if (message.type === "create_group_success") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                if (message.is_private) {
                    const logoutButton = document.getElementById('logout-button');
                    if (logoutButton) logoutButton.style.display = 'none';
                }
                updateSwipeHint();
                alert(`Grupo ${message.group_id} creado exitosamente`);
                console.log(`Grupo creado: ${message.group_id}, privado: ${message.is_private}`);
            } else if (message.type === "create_group_error") {
                alert(`Error al crear el grupo: ${message.message}`);
                console.error(`Error al crear grupo: ${message.message}`);
            } else if (message.type === "check_group") {
                if (!message.in_group) {
                    currentGroup = null;
                    localStorage.removeItem('groupId');
                    updateSwipeHint();
                    console.log("No estás en el grupo, currentGroup restablecido a null");
                }
            } else if (message.type === "flight_update") {
                flightData = message.flights || [];
                updateFlightInfo();
                updateMap();
                if (announcementsEnabled) {
                    flightData.filter(f => f.destination === 'SABE').forEach(flight => {
                        if (!announcedFlights.includes(flight.flight_number) && flight.status === "Próximo a aterrizar") {
                            announceFlight(flight);
                            announcedFlights.push(flight.flight_number);
                        }
                    });
                }
            } else if (message.type === "announcement") {
                if (announcementsEnabled) {
                    playAnnouncement(message.audio_url);
                }
            } else if (message.type === "register_success") {
                console.log("Registro exitoso:", message.message);
            } else if (message.type === "connection_success") {
                console.log("Conexión exitosa");
            } else if (message.type === "logout_success") {
                console.log("Cierre de sesión exitoso");
                completeLogout();
            } else if (message.type === "pong") {
                console.log("Pong recibido del servidor");
            } else if (message.type === "error") {
                console.error("Error del servidor:", message.message);
                if (message.message === "Usuario no registrado") {
                    console.warn("Sesión inválida, pero manteniendo vuelos visibles");
                    localStorage.removeItem('sessionToken');
                    document.getElementById('auth-section').style.display = 'block';
                    document.getElementById('main').style.display = 'block';
                    updateOpenSkyData();
                }
            } else {
                console.warn("Tipo de mensaje desconocido:", message.type);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos recibidos:", event.data);
        }
    };

    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
        updateOpenSkyData();
    };

    ws.onclose = function() {
        console.log("WebSocket cerrado");
        stopPing();
        const sessionToken = localStorage.getItem('sessionToken');
        if (sessionToken && retryCount < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 30000);
            reconnectInterval = setTimeout(() => {
                validateToken(sessionToken).then(isValid => {
                    if (isValid) {
                        connectWebSocket(sessionToken, retryCount + 1);
                    } else {
                        console.warn("Token inválido, manteniendo vuelos");
                        document.getElementById('main').style.display = 'block';
                        updateOpenSkyData();
                    }
                });
            }, delay);
        } else {
            console.warn("No hay sessionToken o límite de reconexiones alcanzado, manteniendo vuelos");
            document.getElementById('main').style.display = 'block';
            updateOpenSkyData();
        }
    };
}

// Mantener conexión viva con ping
function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
            console.log("Ping enviado al servidor");
        }
    }, PING_INTERVAL);
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// Funciones de vuelos
function updateFlightInfo() {
    const departuresTable = document.getElementById('departures-table');
    const arrivalsTable = document.getElementById('arrivals-table');
    const groupDeparturesTable = document.getElementById('group-departures-table');
    const groupArrivalsTable = document.getElementById('group-arrivals-table');

    if (!departuresTable || !arrivalsTable || !groupDeparturesTable || !groupArrivalsTable) {
        console.error("Tablas de vuelos no encontradas en el DOM");
        return;
    }

    // Filtrar vuelos de Aerolíneas Argentinas
    const filteredFlights = flightData.filter(flight => flight.flight_number.startsWith('AR'));

    // Clasificar en Salidas y Llegadas
    const departures = filteredFlights.filter(flight => flight.origin === 'SABE');
    const arrivals = filteredFlights.filter(flight => flight.destination === 'SABE');

    // Actualizar tablas
    const updateTable = (table, flights, isArrival) => {
        table.innerHTML = `
            <tr>
                <th>Matrícula</th>
                <th>Número de Vuelo</th>
                <th>STA</th>
                <th>Posición</th>
                <th>${isArrival ? 'Origen' : 'Destino'}</th>
                <th>Hora Real</th>
                <th>Acción</th>
            </tr>
        `;
        flights.forEach(flight => {
            const row = document.createElement('tr');
            row.className = 'tams-row';
            row.style.color = flight.color || 'black';
            const sta = flight.sta ? new Date(flight.sta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
            const eta = flight.eta ? new Date(flight.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
            row.innerHTML = `
                <td>${flight.registration || 'N/A'}</td>
                <td>${flight.flight_number || 'N/A'}</td>
                <td>${sta}</td>
                <td>${flight.position || 'N/A'}</td>
                <td>${isArrival ? (flight.origin || 'N/A') : (flight.destination || 'N/A')}</td>
                <td>${eta}</td>
                <td><button class="tams-details-btn" onclick="showFlightDetails(${JSON.stringify(flight).replace(/"/g, '&quot;')})">Ver Más</button></td>
            `;
            table.appendChild(row);
        });
    };

    updateTable(departuresTable, departures, false);
    updateTable(arrivalsTable, arrivals, true);
    updateTable(groupDeparturesTable, departures, false);
    updateTable(groupArrivalsTable, arrivals, true);

    filterFlights(localStorage.getItem('lastSearchQuery') || '');
}

function showFlightDetails(flight) {
    const modal = document.getElementById('flight-details-modal');
    const content = document.getElementById('flight-details-content');
    if (!modal || !content) {
        console.error("Modal de detalles no encontrado en el DOM");
        return;
    }

    content.innerHTML = '<h3>Detalles del Vuelo</h3>';
    if (flight.additional_data && Object.keys(flight.additional_data).length > 0) {
        const list = document.createElement('ul');
        for (const [key, value] of Object.entries(flight.additional_data)) {
            const item = document.createElement('li');
            item.textContent = `${key}: ${value}`;
            list.appendChild(item);
        }
        content.appendChild(list);
    } else {
        content.innerHTML += '<p>No hay datos adicionales disponibles.</p>';
    }

    const closeButton = document.createElement('button');
    closeButton.className = 'close-btn';
    closeButton.textContent = '×';
    closeButton.onclick = () => modal.style.display = 'none';
    content.appendChild(closeButton);

    modal.style.display = 'block';
}

async function updateOpenSkyData() {
    if (!updatesEnabled) {
        console.log("Actualizaciones pausadas, omitiendo solicitud");
        setTimeout(updateOpenSkyData, 15000);
        return;
    }

    if (dailyTokenCount >= MAX_TOKENS_DAILY) {
        console.warn("Límite de tokens diarios alcanzado:", dailyTokenCount);
        alert("Se alcanzó el límite diario de consultas a FlightRadar24. Las actualizaciones se pausarán hasta mañana.");
        updatesEnabled = false;
        const updatesToggleBtn = document.getElementById('updates-toggle');
        if (updatesToggleBtn) {
            updatesToggleBtn.classList.remove('active');
            updatesToggleBtn.textContent = 'Reanudar Actualizaciones';
        }
        return;
    }

    console.log("Ejecutando updateOpenSkyData...");
    try {
        const response = await fetch(`/api/flights?limit=${MAX_FLIGHTS_PER_REQUEST}`);
        console.log("Respuesta de /api/flights:", response.status, response.statusText);
        if (response.ok) {
            const data = await response.json();
            console.log("Datos recibidos de /api/flights:", JSON.stringify(data, null, 2));
            flightData = Array.isArray(data.flights) ? data.flights : [];
            dailyTokenCount += flightData.length * TOKENS_PER_FLIGHT;
            console.log("Tokens consumidos:", dailyTokenCount);

            updateFlightInfo();
            updateMap();

            if (announcementsEnabled) {
                flightData.filter(f => f.destination === 'SABE').forEach(flight => {
                    if (!announcedFlights.includes(flight.flight_number) && flight.status === "Próximo a aterrizar") {
                        announceFlight(flight);
                        announcedFlights.push(flight.flight_number);
                    }
                });
            }
        } else {
            console.warn("Error al cargar /api/flights:", response.status, response.statusText);
            throw new Error("Respuesta no OK");
        }
    } catch (err) {
        console.error("Error al cargar datos de vuelos:", err);
        const tables = [
            document.getElementById('departures-table'),
            document.getElementById('arrivals-table'),
            document.getElementById('group-departures-table'),
            document.getElementById('group-arrivals-table')
        ];
        tables.forEach(table => {
            if (table) table.innerHTML = "<tr><td colspan='7'>Error al cargar datos</td></tr>";
        });
    }
    setTimeout(updateOpenSkyData, 15000);
}

function announceFlight(flight) {
    const utterance = new SpeechSynthesisUtterance();
    const eta = flight.eta ? new Date(flight.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "N/A";
    utterance.text = `Vuelo ${flight.flight_number} procedente de ${flight.origin} está próximo a aterrizar. Tiempo estimado de llegada: ${eta}. Estado: ${flight.status}.`;
    utterance.lang = 'es-ES';
    speechSynthesis.speak(utterance);
}

// Funciones de mapa
function initMap() {
    console.log("Inicializando mapa...");
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado en el DOM");
        alert("Error: No se puede cargar el mapa. Contenedor no encontrado.");
        return;
    }
    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(map);
        const aeroparqueIcon = L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30],
        });
        L.marker([-34.5597, -58.4116], { icon: aeroparqueIcon })
            .addTo(map)
            .bindPopup("Aeroparque")
            .openPopup();
        console.log("Mapa inicializado correctamente");
        map.invalidateSize();
    } catch (error) {
        console.error("Error al inicializar Leaflet:", error);
        alert("Error al cargar el mapa. Verifica tu conexión o recarga la página.");
    }
}

function updateMap() {
    if (!map) return;

    // Limpiar marcadores existentes
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    // Filtrar vuelos con datos de posición
    const validFlights = flightData.filter(flight => flight.lat && flight.lon && flight.flight_number.startsWith('AR'));

    validFlights.forEach(flight => {
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
            <b>Origen:</b> ${flight.origin || 'N/A'}<br>
            <b>Destino:</b> ${flight.destination || 'N/A'}<br>
            <b>ETA:</b> ${flight.eta ? new Date(flight.eta).toLocaleTimeString() : 'N/A'}
        `);
        marker.flight = flight;
        markers.push(marker);
    });

    filterFlights(localStorage.getItem('lastSearchQuery') || '');
    map.invalidateSize();
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.07;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function estimateArrivalTime(lat, lon, speed) {
    const aeroparqueLat = -34.5597;
    const aeroparqueLon = -58.4116;
    const distance = calculateDistance(lat, lon, aeroparqueLat, aeroparqueLon);
    if (!speed || speed <= 0) return "N/A";
    const timeHours = distance / speed;
    const now = new Date();
    const arrivalTime = new Date(now.getTime() + timeHours * 60 * 60 * 1000);
    return arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase().replace(":", "");
}

function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "En zona";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

// Funciones de grabación
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!talkButton) {
        console.error("Botón #talk no encontrado en el DOM");
        return;
    }

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("Iniciando grabación...");
        stream = await requestMicPermission();
        if (!stream) {
            console.error("No se pudo obtener el stream del micrófono");
            alert("No se pudo acceder al micrófono. Por favor, verifica los permisos.");
            return;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            console.log("MediaRecorder creado con mimeType: audio/webm");
        } catch (err) {
            console.error("Error al crear MediaRecorder:", err);
            alert("Error al iniciar la grabación: " + err.message);
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        let audioChunks = [];
        let transcript = supportsSpeechRecognition ? "" : "Procesando...";

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    transcript += event.results[i][0].transcript;
                }
                console.log("Transcripción parcial:", transcript);
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción: " + event.error;
                alert("Error en speech-to-text: " + event.error);
            };
            try {
                recognition.start();
                console.log("SpeechRecognition iniciado");
            } catch (err) {
                console.error("Error al iniciar SpeechRecognition:", err);
            }
        }

        mediaRecorder.ondataavailable = function(event) {
            console.log("Datos de audio disponibles:", event.data.size, "bytes");
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            } else {
                console.warn("Fragmento de audio vacío recibido");
            }
        };

        mediaRecorder.onstop = function() {
            console.log("Grabación detenida");
            console.log("Tamaño de audioChunks:", audioChunks.length);
            if (audioChunks.length === 0) {
                console.error("No se capturaron fragmentos de audio");
                alert("No se grabó ningún audio. Verifica tu micrófono.");
                return;
            }
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            console.log("Audio Blob creado, tamaño:", audioBlob.size, "bytes");
            if (audioBlob.size === 0) {
                console.error("Audio Blob vacío");
                alert("El audio grabado está vacío. Verifica tu micrófono.");
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = function() {
                const base64data = reader.result.split(',')[1];
                console.log("Audio convertido a Base64, longitud:", base64data.length);
                const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = localStorage.getItem("userName") || "Anónimo";
                const userFunction = localStorage.getItem("userFunction") || "Desconocida";
                const message = {
                    type: "audio",
                    data: base64data,
                    text: transcript,
                    timestamp: timestamp,
                    sender: sender,
                    function: userFunction,
                    sessionToken: localStorage.getItem("sessionToken")
                };

                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log("Enviando mensaje al servidor:", {
                        type: message.type,
                        data: message.data.slice(0, 20) + "...",
                        text: message.text,
                        timestamp: message.timestamp,
                        sender: message.sender,
                        function: message.function
                    });
                    ws.send(JSON.stringify(message));
                } else {
                    console.warn("WebSocket no está abierto, encolando mensaje");
                    queueMessageForSync(message);
                }

                const chatList = document.getElementById("chat-list");
                if (chatList) {
                    const msgDiv = document.createElement("div");
                    msgDiv.className = "chat-message";
                    msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${transcript}`;
                    msgDiv.onclick = () => playAudio(audioBlob);
                    chatList.appendChild(msgDiv);
                    chatList.scrollTop = chatList.scrollHeight;
                } else {
                    console.error("Elemento #chat-list no encontrado en el DOM");
                }
            };
            reader.onerror = function(err) {
                console.error("Error al leer el audio como Base64:", err);
                alert("Error al procesar el audio: " + err.message);
            };
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) {
                recognition.stop();
            }
        };

        mediaRecorder.onerror = function(err) {
            console.error("Error en MediaRecorder:", err);
            alert("Error durante la grabación: " + err.message);
        };

        try {
            mediaRecorder.start(100);
            console.log("Grabación iniciada");
            talkButton.classList.add("recording");
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            alert("Error al iniciar la grabación: " + err.message);
            stream.getTracks().forEach(track => track.stop());
        }
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.classList.remove("recording");
    }
}

async function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) {
        console.error("Botón #group-talk no encontrado en el DOM");
        return;
    }
    if (!groupRecording) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                groupMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                const chunks = [];
                groupMediaRecorder.ondataavailable = e => {
                    if (e.data.size > 0) chunks.push(e.data);
                };
                groupMediaRecorder.onstop = () => {
                    const blob = new Blob(chunks, { type: 'audio/webm' });
                    if (blob.size === 0) {
                        console.error("Blob de grupo vacío");
                        alert("El audio grabado está vacío. Verifica tu micrófono.");
                        return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                        const audioData = reader.result.split(',')[1];
                        sendGroupMessage(audioData);
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach(track => track.stop());
                };
                groupMediaRecorder.start(100);
                groupRecording = true;
                talkButton.classList.add("recording");
                console.log("Grabación de grupo iniciada");
            })
            .catch(err => {
                console.error('Error al acceder al micrófono:', err);
                alert('No se pudo acceder al micrófono. Por favor, verifica los permisos de la app.');
            });
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.classList.remove("recording");
        console.log("Grabación de grupo detenida");
    }
}

function sendGroupMessage(audioData) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const message = {
        type: 'group_message',
        data: audioData,
        sender: localStorage.getItem('userName') || "Anónimo",
        function: localStorage.getItem('userFunction') || "Desconocida",
        timestamp: timestamp,
        text: supportsSpeechRecognition ? "Procesando..." : "Procesando...",
        sessionToken: localStorage.getItem("sessionToken"),
        group_id: currentGroup
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        console.log("Mensaje de grupo enviado:", {
            type: message.type,
            data: message.data.slice(0, 20) + "...",
            text: message.text,
            timestamp: message.timestamp,
            sender: message.sender,
            function: message.function,
            group_id: message.group_id
        });
    } else {
        console.warn("WebSocket no está abierto, encolando mensaje de grupo");
        queueMessageForSync(message);
    }
}

// Funciones de muteo
function toggleMute() {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (muteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("unmuted");
            groupMuteButton.classList.add("muted");
        }
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("muted");
            groupMuteButton.classList.add("unmuted");
        }
    }
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById("group-mute");
    const muteButton = document.getElementById("mute");
    if (groupMuteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        groupMuteButton.classList.remove("unmuted");
        groupMuteButton.classList.add("muted");
        if (muteButton) {
            muteButton.classList.remove("unmuted");
            muteButton.classList.add("muted");
        }
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        groupMuteButton.classList.remove("muted");
        groupMuteButton.classList.add("unmuted");
        if (muteButton) {
            muteButton.classList.remove("muted");
            muteButton.classList.add("unmuted");
        }
    }
}

function updateMuteButton(isMuted) {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (isMuted) {
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("unmuted");
            groupMuteButton.classList.add("muted");
        }
    } else {
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("muted");
            groupMuteButton.classList.add("unmuted");
        }
    }
}

function toggleMuteNonGroup() {
    const nonGroupMuteButton = document.getElementById("mute-non-group");
    const isMuting = !nonGroupMuteButton.classList.contains("muted");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuting ? "mute_non_group" : "unmute_non_group", group_id: currentGroup }));
    }
    if (isMuting) {
        nonGroupMuteButton.classList.add("muted");
        nonGroupMuteButton.textContent = "Desmutear no grupo";
    } else {
        nonGroupMuteButton.classList.remove("muted");
        nonGroupMuteButton.textContent = "Mutear no grupo";
    }
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} desmuteado`);
    } else {
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} muteado`);
    }
}

// Funciones de usuarios
function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) {
        console.error("Elementos #users o #group-users no encontrados en el DOM");
        return;
    }
    usersDiv.innerHTML = `Usuarios conectados: ${count}<br>`;
    groupUsersDiv.innerHTML = `Usuarios conectados: ${list.filter(user => user.group_id === currentGroup).length}<br>`;
    const userList = document.createElement("div");
    userList.className = "user-list";
    const groupUserList = document.createElement("div");
    groupUserList.className = "user-list";

    list.forEach(user => {
        const userDiv = document.createElement("div");
        userDiv.className = "user-item";
        if (user.group_id && user.group_id === currentGroup) {
            userDiv.classList.add('in-group');
        }
        const muteButton = document.createElement("button");
        muteButton.className = "mute-button";
        const isMuted = mutedUsers.has(user.user_id);
        muteButton.textContent = isMuted ? "🔇" : "🔊";
        muteButton.onclick = () => toggleMuteUser(user.user_id, muteButton);
        userDiv.appendChild(muteButton);
        const userText = document.createElement("span");
        let displayText = user.display;
        if (!displayText || displayText === user.user_id) {
            const parts = user.user_id.split('_');
            if (parts.length === 3) {
                const [, name, userFunction] = parts;
                displayText = `${name} (${userFunction})`;
            } else {
                displayText = user.user_id;
            }
        }
        userText.textContent = displayText;
        userDiv.appendChild(userText);
        userList.appendChild(userDiv);

        if (user.group_id === currentGroup) {
            const groupUserDiv = document.createElement("div");
            groupUserDiv.className = "user-item";
            const groupMuteButton = document.createElement("button");
            groupMuteButton.className = "mute-button";
            groupMuteButton.textContent = isMuted ? "🔇" : "🔊";
            groupMuteButton.onclick = () => toggleMuteUser(user.user_id, groupMuteButton);
            groupUserDiv.appendChild(groupMuteButton);
            const groupUserText = document.createElement("span");
            groupUserText.textContent = displayText;
            groupUserDiv.appendChild(groupUserText);
            groupUserList.appendChild(groupUserDiv);
        }
    });

    usersDiv.appendChild(userList);
    groupUsersDiv.appendChild(groupUserList);
    console.log("Lista de usuarios actualizada:", list);
}

// Funciones de grupos
function createGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("Enviando solicitud para crear grupo:", groupId, "Privado:", isPrivate);
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
    }
}

function joinGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("Enviando solicitud para unirse al grupo:", groupId, "Privado:", isPrivate);
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
    }
}

function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        localStorage.removeItem('groupId');
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('group-chat-list').innerHTML = '';
        document.getElementById('group-departures-table').innerHTML = '';
        document.getElementById('group-arrivals-table').innerHTML = '';
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) logoutButton.style.display = 'block';
        updateSwipeHint();
        console.log("Grupo abandonado");
    }
}

function checkGroupStatus() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'check_group', group_id: currentGroup }));
    }
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (!swipeHint || !returnToGroupBtn) {
        console.error("Elemento #swipe-hint o #return-to-group-btn no encontrado en el DOM");
        return;
    }
    if (currentGroup) {
        if (document.getElementById('main').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la derecha para ir al grupo';
            returnToGroupBtn.style.display = 'block';
        } else if (document.getElementById('group-screen').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la izquierda para volver';
            returnToGroupBtn.style.display = 'none';
        }
    } else {
        swipeHint.style.display = 'none';
        returnToGroupBtn.style.display = 'none';
    }
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

function backToMainFromGroup() {
    document.getElementById('group-screen').classList.add('slide-right');
    setTimeout(() => {
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('group-screen').classList.remove('slide-right');
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) logoutButton.style.display = 'block';
        checkGroupStatus();
        updateSwipeHint();
    }, 300);
}

// Funciones de navegación
function showGroupRadar() {
    console.log("Mostrando radar desde grupo...");
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    loadHistory();
}

function showRadar() {
    console.log("Mostrando radar...");
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function backToMainFromRadar() {
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    document.getElementById("search-bar").value = "";
    filterFlights();
    updateSwipeHint();
}

function showHistory() {
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("history-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    loadHistory();
}

function backToMain() {
    document.getElementById("history-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    updateSwipeHint();
    console.log("Volviendo a la pantalla principal desde historial");
}

// Funciones auxiliares
function base64ToBlob(base64, mime) {
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([uint8Array], { type: mime });
    } catch (err) {
        console.error("Error al convertir Base64 a Blob:", err);
        return null;
    }
}

function logout() {
    console.log("Iniciando cierre de sesión...");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    console.log("Completando cierre de sesión...");
    if (ws) {
        ws.close();
        ws = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    localStorage.removeItem("sessionToken");
    localStorage.removeItem("userName");
    localStorage.removeItem("userFunction");
    localStorage.removeItem("userLegajo");
    localStorage.removeItem("groupId");
    localStorage.removeItem("lastSearchQuery");
    currentGroup = null;
    mutedUsers.clear();
    clearInterval(reconnectInterval);
    stopPing();
    document.getElementById("auth-section").style.display = "block";
    document.getElementById("main").style.display = "none";
}

// Funciones de notificaciones
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        fetch('/templates/sw.js', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    navigator.serviceWorker.register('/templates/sw.js')
                        .then(() => console.log('Service Worker registrado'))
                        .catch(err => console.error('Error al registrar Service Worker:', err));
                } else {
                    console.warn('Archivo sw.js no encontrado.');
                }
            })
            .catch(err => {
                console.warn('No se pudo verificar sw.js:', err);
            });
    } else {
        console.warn('Service Worker no soportado.');
    }
}

function checkNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            console.log('Permiso de notificación ya concedido');
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Permiso de notificación concedido');
                } else {
                    console.warn('Permiso de notificación denegado');
                }
            }).catch(err => {
                console.error('Error al solicitar permiso de notificación:', err);
            });
        } else {
            console.warn('Permiso de notificación denegado previamente');
        }
    } else {
        console.warn('Notificaciones no soportadas en este navegador');
    }
}

// Función para cargar historial
function loadHistory() {
    fetch('/history')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error al cargar historial: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const historyList = document.getElementById("history-list");
            if (!historyList) {
                console.error("Elemento #history-list no encontrado en el DOM");
                return;
            }
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = msg.timestamp.split(":");
                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const text = msg.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${text}`;
                const audioBlob = base64ToBlob(msg.audio, 'audio/webm');
                if (audioBlob) {
                    msgDiv.onclick = () => playAudio(audioBlob);
                } else {
                    console.error("No se pudo crear Blob para mensaje del historial:", msg);
                }
                historyList.appendChild(msgDiv);
            });
            console.log("Historial cargado con", data.length, "mensajes");
        })
        .catch(err => {
            console.error("Error al cargar historial:", err);
            const historyList = document.getElementById("history-list");
            if (historyList) {
                historyList.innerHTML = "<div>Error al cargar el historial</div>";
            }
        });
}

// Event listeners
document.addEventListener('click', unlockAudio, { once: true });

let lastVolumeUpTime = 0;
let volumeUpCount = 0;

document.addEventListener('keydown', (event) => {
    if (event.key === 'VolumeUp') {
        event.preventDefault();
        const currentTime = Date.now();
        const timeDiff = currentTime - lastVolumeUpTime;

        if (timeDiff < 500) {
            volumeUpCount++;
            if (volumeUpCount === 2) {
                toggleTalk();
                volumeUpCount = 0;
            }
        } else {
            volumeUpCount = 1;
        }
        lastVolumeUpTime = currentTime;
    }
});

document.addEventListener('touchstart', e => {
    if (!isSwiping) {
        startX = e.touches[0].clientX;
    }
});

document.addEventListener('touchmove', e => {
    if (!isSwiping) {
        currentX = e.touches[0].clientX;
    }
});

document.addEventListener('touchend', e => {
    if (isSwiping) return;
    const deltaX = currentX - startX;
    if (Math.abs(deltaX) > 50) {
        if (deltaX > 0 && document.getElementById('group-screen').style.display === 'block') {
            backToMainFromGroup();
        } else if (deltaX < 0 && document.getElementById('main').style.display === 'block' && currentGroup) {
            returnToGroup();
        }
    }
});
