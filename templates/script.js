// Variables globales
let ws = null;
let pingInterval = null;
let userId = null;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder = null;
let token = null;
let isRecording = false;
let stream = null;
let map = null;
let groupId = null;
let audioQueue = [];
let isPlaying = false;
let markers = [];
let recognition = null;
let supportsSpeechRecognition = false;
let mutedUsers = new Set();
let currentGroup = null;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let flightData = [];
let reconnectInterval = null;
let flightInterval = null;
let groupRecording = false;
let groupMediaRecorder = null;
let lastVolumeUpTime = 0;
let volumeUpCount = 0;
const PING_INTERVAL = 30000; // Ping cada 30 segundos
const RECONNECT_BASE_DELAY = 5000; // Reintento base cada 5 segundos
const SYNC_TAG = 'sync-messages'; // Tag para sincronización

// Mapeo de aerolíneas
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

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

// Inicialización al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    // Registrar Service Worker
    registerServiceWorker();

    // Verificar sesión activa
    const sessionToken = localStorage.getItem('sessionToken');
    const userName = localStorage.getItem('userName');
    const userFunction = localStorage.getItem('userFunction');
    const userLegajo = localStorage.getItem('userLegajo');

    if (sessionToken && userName && userFunction && userLegajo) {
        userId = `${userLegajo}_${userName}_${userFunction}`;
        token = sessionToken;
        connectWebSocket(sessionToken);
        showScreen('main');
        checkGroupStatus();
        fetchAEPFlights();
        startFlightUpdates();
    } else {
        showScreen('login-form');
    }
    document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const surname = document.getElementById('surname').value;
    const employee_id = document.getElementById('employee_id').value;
    const sector = document.getElementById('sector').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, sector, password })
        });
        const data = await response.json();
        if (response.ok) {
            alert('Registro exitoso');
            // Redirigir al formulario de login
        } else {
            alert(`Error: ${data.detail}`);
        }
    } catch (error) {
        console.error('Error en registro:', error);
        alert('Error al registrarse');
    }
});

    // Event listeners para formularios
    const loginForm = document.getElementById('login');
    const registerForm = document.getElementById('register');
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');

    document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
            const surname = document.getElementById('surname').value;
            const employee_id = document.getElementById('employee_id').value;
            const sector = document.getElementById('sector').value;
            const password = document.getElementById('password').value;
            const errorElement = document.getElementById('login-error');

            try {
                const response = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surname, employee_id, sector, password })
                });
                const data = await response.json();
                if (response.ok) {
                    userId = `${employeeId}_${surname}_${sector}`;
                    token = data.sessionToken;
                    localStorage.setItem('sessionToken', token);
                    localStorage.setItem('userName', surname);
                    localStorage.setItem('userFunction', sector);
                    localStorage.setItem('userLegajo', employeeId);
                    connectWebSocket(token);
                    showScreen('main');
                    errorElement.textContent = '';
                } else {
                    errorElement.textContent = data.error || 'Error al iniciar sesión';
                }
            } catch (error) {
                console.error('Error en registro:', error);
                alert('Error al registrrse');
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const surname = document.getElementById('register-surname').value;
            const employeeId = document.getElementById('register-employee-id').value;
            const sector = document.getElementById('register-sector').value;
            const errorElement = document.getElementById('register-error');

            if (!/^\d{5}$/.test(employeeId)) {
                errorElement.textContent = 'El legajo debe contener exactamente 5 números.';
                return;
            }

            try {
                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surname, employeeId, sector })
                });
                const data = await response.json();
                if (response.ok) {
                    userId = `${employeeId}_${surname}_${sector}`;
                    token = data.sessionToken;
                    localStorage.setItem('sessionToken', token);
                    localStorage.setItem('userName', surname);
                    localStorage.setItem('userFunction', sector);
                    localStorage.setItem('userLegajo', employeeId);
                    connectWebSocket(token);
                    showScreen('main');
                    errorElement.textContent = '';
                } else {
                    errorElement.textContent = data.error || 'Error al registrarse';
                }
            } catch (error) {
                console.error('Error en registro:', error);
                errorElement.textContent = 'Error al conectar con el servidor';
            }
        });
    }

    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-form').style.display = 'none';
            document.getElementById('register-form').style.display = 'block';
        });
    }

    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        });
    }

    // Botón de búsqueda
    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', sendSearchQuery);
    }

    // Botones de detalles de vuelos
    document.querySelectorAll('#flight-details-button').forEach(button => {
        button.addEventListener('click', openFlightDetailsModal);
    });

    // Botón de cerrar modal
    const closeModal = document.getElementById('close-modal');
    if (closeModal) {
        closeModal.addEventListener('click', closeFlightDetailsModal);
    }

    // Cerrar modal al hacer clic fuera
    const flightDetailsModal = document.getElementById('flight-details-modal');
    if (flightDetailsModal) {
        flightDetailsModal.addEventListener('click', (e) => {
            if (e.target === flightDetailsModal) {
                closeFlightDetailsModal();
            }
        });
    }

    // Botón de logout
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    // Botones de grupo
    const joinGroupBtn = document.getElementById('join-group-btn');
    const createGroupBtn = document.getElementById('create-group-btn');
    const leaveGroupBtn = document.getElementById('leave-group-btn');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');

    if (joinGroupBtn) joinGroupBtn.addEventListener('click', joinGroup);
    if (createGroupBtn) createGroupBtn.addEventListener('click', createGroup);
    if (leaveGroupBtn) leaveGroupBtn.addEventListener('click', leaveGroup);
    if (returnToGroupBtn) returnToGroupBtn.addEventListener('click', returnToGroup);

    // Botones de radar e historial
    const radarBtn = document.getElementById('radar');
    const historyBtn = document.getElementById('history');
    const groupRadarBtn = document.getElementById('group-radar');
    const groupHistoryBtn = document.getElementById('group-history');
    const backToMainBtn = document.getElementById('back-to-main');

    if (radarBtn) radarBtn.addEventListener('click', showRadar);
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    if (groupRadarBtn) groupRadarBtn.addEventListener('click', showGroupRadar);
    if (groupHistoryBtn) groupHistoryBtn.addEventListener('click', showGroupHistory);
    if (backToMainBtn) backToMainBtn.addEventListener('click', backToMainFromGroup);

    // Botones de audio
    const talkBtn = document.getElementById('talk');
    const muteBtn = document.getElementById('mute');
    const groupTalkBtn = document.getElementById('group-talk');
    const groupMuteBtn = document.getElementById('group-mute');
    const muteNonGroupBtn = document.getElementById('mute-non-group');

    if (talkBtn) talkBtn.addEventListener('click', toggleTalk);
    if (muteBtn) muteBtn.addEventListener('click', toggleMute);
    if (groupTalkBtn) groupTalkBtn.addEventListener('click', toggleGroupTalk);
    if (groupMuteBtn) groupMuteBtn.addEventListener('click', toggleGroupMute);
    if (muteNonGroupBtn) muteNonGroupBtn.addEventListener('click', toggleMuteNonGroup);

    // Filtro de radar
    const searchBar = document.getElementById('search-bar');
    if (searchBar) searchBar.addEventListener('input', filterFlights);

    // Cerrar radar
    const closeRadarBtn = document.querySelector('.close-btn');
    if (closeRadarBtn) closeRadarBtn.addEventListener('click', backToMainFromRadar);

    checkNotificationPermission();

    // Escuchar mensajes del Service Worker
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'SEND_MESSAGE' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event.data.message));
            console.log('Mensaje sincronizado enviado:', event.data.message);
        } else if (event.data && event.data.type === 'SYNC_COMPLETE') {
            console.log('Sincronización completada');
        }
    });

    // Gestos táctiles
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

    // Tecla VolumeUp
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

    // Desbloquear audio
    document.addEventListener('click', unlockAudio, { once: true });
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
                connectWebSocket(sessionToken);
            }
        }
    }
});

// Mostrar pantallas
function showScreen(screenId) {
    document.querySelectorAll('#login-form, #register-form, #main, #group-screen, #radar-screen, #history-screen')
        .forEach(screen => screen.style.display = 'none');
    document.getElementById(screenId).style.display = 'block';

    if (screenId === 'main' || screenId === 'group-screen') {
        fetchAEPFlights();
        startFlightUpdates();
    } else {
        stopFlightUpdates();
    }
}

// Actualizaciones de vuelos
function startFlightUpdates() {
    stopFlightUpdates();
    flightInterval = setInterval(fetchAEPFlights, 5 * 60 * 1000);
    console.log('Iniciando actualizaciones de vuelos cada 5 minutos');
}

function stopFlightUpdates() {
    if (flightInterval) {
        clearInterval(flightInterval);
        flightInterval = null;
        console.log('Actualizaciones de vuelos detenidas');
    }
}

// Encolar mensajes para sincronización
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

// Obtener vuelos
async function fetchAEPFlights() {
    try {
        const response = await fetch('/api/flights');
        if (!response.ok) {
            throw new Error(`Error al obtener vuelos: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        flightData = data.flights;
        localStorage.setItem('flightData', JSON.stringify(flightData));
        updateFlightTable(flightData);
    } catch (error) {
        console.error('Error en fetchAEPFlights:', error);
        const cachedFlights = JSON.parse(localStorage.getItem('flightData')) || [];
        if (cachedFlights.length > 0) {
            updateFlightTable(cachedFlights);
        } else {
            const tbodies = document.querySelectorAll('#flights-table tbody');
            tbodies.forEach(tbody => {
                tbody.innerHTML = '<tr><td colspan="6">Error al cargar vuelos</td></tr>';
            });
        }
    }
}

function updateFlightTable(flights) {
    const tbodies = document.querySelectorAll('#flights-table tbody');
    tbodies.forEach(tbody => {
        tbody.innerHTML = '';
        flights.forEach(flight => {
            const statusClass = getFlightStatusClass(flight.status);
            const row = document.createElement('tr');
            row.className = statusClass;
            row.innerHTML = `
                <td>${flight.flight_number || 'N/A'}</td>
                <td>${flight.departure_airport || 'N/A'}</td>
                <td>${flight.departure_time ? new Date(flight.departure_time).toLocaleString('es-AR') : 'N/A'}</td>
                <td>${flight.arrival_airport || 'N/A'}</td>
                <td>${flight.arrival_time ? new Date(flight.arrival_time).toLocaleString('es-AR') : 'N/A'}</td>
                <td>${flight.status || 'Desconocido'}</td>
            `;
            tbody.appendChild(row);
        });
    });
}

function getFlightStatusClass(status) {
    if (!status) return '';
    const statusLower = status.toLowerCase();
    if (statusLower.includes('aterrizando') || statusLower.includes('landing')) return 'flight-aterrizando';
    if (statusLower.includes('en vuelo') || statusLower.includes('en route')) return 'flight-en-vuelo';
    if (statusLower.includes('despegando') || statusLower.includes('taking off')) return 'flight-despegando';
    if (statusLower.includes('en tierra') || statusLower.includes('on ground')) return 'flight-en-tierra';
    if (statusLower.includes('salida') || statusLower.includes('departed')) return 'flight-salida';
    return '';
}

// Modal de detalles de vuelos
function openFlightDetailsModal() {
    const modal = document.getElementById('flight-details-modal');
    const modalTableBody = document.getElementById('modal-flight-table').querySelector('tbody');
    const mainTableBody = document.querySelector('#flights-table tbody');

    if (!modal || !modalTableBody || !mainTableBody) {
        console.error('Elementos del modal o tabla no encontrados');
        return;
    }

    modalTableBody.innerHTML = mainTableBody.innerHTML || '<tr><td colspan="6">No hay datos disponibles</td></tr>';
    modal.style.display = 'block';

    modalTableBody.querySelectorAll('tr').forEach(row => {
        row.addEventListener('click', async () => {
            const flightNumber = row.cells[0].textContent;
            try {
                const response = await fetch(`/api/flight_details/${flightNumber}`);
                if (!response.ok) throw new Error('Error al obtener detalles');
                const details = await response.json();
                displayFlightDetails(details);
            } catch (error) {
                console.error('Error al obtener detalles:', error);
                alert('Error al cargar detalles del vuelo');
            }
        });
    });
}

function displayFlightDetails(details) {
    alert(`Detalles del vuelo ${details.flight_number}:
- Origen: ${details.departure_airport}
- Destino: ${details.arrival_airport}
- Salida: ${details.departure_time ? new Date(details.departure_time).toLocaleString('es-AR') : 'N/A'}
- Llegada: ${details.arrival_time ? new Date(details.arrival_time).toLocaleString('es-AR') : 'N/A'}
- Estado: ${details.status}`);
}

function closeFlightDetailsModal() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Búsqueda de vuelos
function sendSearchQuery() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) {
        alert('Ingresá una consulta');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'search_query', query }));
        localStorage.setItem('lastSearchQuery', query);
        document.getElementById('search-input').value = '';
        console.log(`Consulta enviada: ${query}`);
    } else {
        alert('No conectado al servidor');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
        localStorage.removeItem('lastSearchQuery');
    }
}

function displaySearchResponse(message) {
    const flightDetails = document.getElementById('flight-details');
    const groupFlightDetails = document.getElementById('group-flight-details');
    if (!flightDetails || !groupFlightDetails) {
        console.error("Elementos #flight-details o #group-flight-details no encontrados en el DOM");
        return;
    }
    flightDetails.innerHTML = '';
    groupFlightDetails.innerHTML = '';

    let flights = [];
    if (typeof message === 'string') {
        flights = parseFlightMessage(message);
    } else if (Array.isArray(message)) {
        flights = message.map(flight => ({
            flightNumber: flight.flight_number || 'N/A',
            destination: flight.arrival_airport || 'N/A',
            status: flight.status || 'Desconocido'
        }));
    } else {
        console.error("Formato de respuesta de búsqueda inválido:", message);
        flightDetails.innerHTML = '<div class="flight no-results">Error al procesar la búsqueda.</div>';
        groupFlightDetails.innerHTML = '<div class="flight no-results">Error al procesar la búsqueda.</div>';
        return;
    }

    const searchQuery = localStorage.getItem('lastSearchQuery') || '';
    const filteredFlights = flights.filter(flight =>
        flight.flightNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flight.destination.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (filteredFlights.length === 0) {
        flightDetails.innerHTML = '<div class="flight no-results">No se encontraron vuelos para la búsqueda.</div>';
        groupFlightDetails.innerHTML = '<div class="flight no-results">No se encontraron vuelos para la búsqueda.</div>';
    } else {
        filteredFlights.forEach(flight => {
            const div = document.createElement('div');
            const statusClass = getFlightStatusClass(flight.status);
            div.className = `flight ${statusClass}`;
            div.innerHTML = `
                <strong>Vuelo:</strong> ${flight.flightNumber} |
                <strong>Destino:</strong> ${flight.destination} |
                <strong>Estado:</strong> ${flight.status}
            `;
            flightDetails.appendChild(div);
            groupFlightDetails.appendChild(div.cloneNode(true));
        });
    }

    flightDetails.scrollTop = flightDetails.scrollHeight;
    groupFlightDetails.scrollTop = groupFlightDetails.scrollHeight;
}

function parseFlightMessage(message) {
    const flights = [];
    try {
        if (typeof message === 'string') {
            const flightEntries = message.split(", ");
            for (let i = 0; i < flightEntries.length; i += 3) {
                if (flightEntries[i].startsWith("AR")) {
                    flights.push({
                        flightNumber: flightEntries[i],
                        destination: flightEntries[i + 1]?.split(" ")[2] || 'N/A',
                        status: flightEntries[i + 2] || 'Desconocido'
                    });
                }
            }
        }
    } catch (err) {
        console.error("Error al parsear mensaje de vuelos:", err);
    }
    return flights;
}

// Conexión WebSocket
function connectWebSocket(sessionToken, retryCount = 0) {
    if (retryCount >= 5) {
        alert('No se pudo reconectar al servidor después de varios intentos.');
        completeLogout();
        return;
    }
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl} (Intento ${retryCount + 1})`);
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        alert("Error al intentar conectar con el servidor.");
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
        showScreen('main');
        updateUsers(0, []);
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
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje recibido:", message);

            if (!message.type) {
                console.error("Mensaje sin tipo:", message);
                return;
            }

            if (message.type === "audio" || message.type === "group_message") {
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
            } else if (message.type === "users") {
                updateUsers(message.count, message.list);
            } else if (message.type === "mute_all_success") {
                updateMuteButton(true);
            } else if (message.type === "unmute_all_success") {
                updateMuteButton(false);
            } else if (message.type === "mute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.add(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.add("muted");
                document.getElementById("mute-non-group").innerHTML = '<img src="/templates/mute.png" alt="Desmutear" style="width: 24px; height: 24px;">';
            } else if (message.type === "unmute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.delete(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.remove("muted");
                document.getElementById("mute-non-group").innerHTML = '<img src="/templates/mute.png" alt="Silenciar" style="width: 24px; height: 24px;">';
            } else if (message.type === "group_joined") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').classList.add('slide-left');
                setTimeout(() => {
                    document.getElementById('main').style.display = 'none';
                    document.getElementById('group-screen').style.display = 'block';
                    document.getElementById('main').classList.remove('slide-left');
                    if (message.is_private) {
                        const logoutButton = document.getElementById('logout-button');
                        if (logoutButton) logoutButton.style.display = 'none';
                    }
                    updateSwipeHint();
                }, 300);
            } else if (message.type === "create_group_success") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').classList.add('slide-left');
                setTimeout(() => {
                    document.getElementById('main').style.display = 'none';
                    document.getElementById('group-screen').style.display = 'block';
                    document.getElementById('main').classList.remove('slide-left');
                    if (message.is_private) {
                        const logoutButton = document.getElementById('logout-button');
                        if (logoutButton) logoutButton.style.display = 'none';
                    }
                    updateSwipeHint();
                    alert(`Grupo ${message.group_id} creado exitosamente`);
                }, 300);
            } else if (message.type === "create_group_error") {
                alert(`Error al crear el grupo: ${message.message}`);
            } else if (message.type === "check_group") {
                if (!message.in_group) {
                    currentGroup = null;
                    localStorage.removeItem('groupId');
                    updateSwipeHint();
                }
            } else if (message.type === "flight_update") {
                flightData = message.flights;
                localStorage.setItem('flightData', JSON.stringify(flightData));
                updateFlightTable(flightData);
            } else if (message.type === "fr24_update") {
                // Soporte opcional para FlightRadar24
                console.log("Actualización FlightRadar24 recibida:", message.flights);
            } else if (message.type === "search_response") {
                displaySearchResponse(message.message);
            } else if (message.type === "register_success") {
                console.log("Registro exitoso:", message.message);
            } else if (message.type === "logout_success") {
                completeLogout();
            } else if (message.type === "pong") {
                console.log("Pong recibido del servidor");
            } else if (message.type === "opensky_update") {
                updateOpenSkyData(message.flights);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos recibidos:", event.data);
        }
    };

    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
    };

    ws.onclose = function() {
        console.log("WebSocket cerrado");
        stopPing();
        const sessionToken = localStorage.getItem('sessionToken');
        if (sessionToken) {
            const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 30000);
            reconnectInterval = setTimeout(() => {
                connectWebSocket(sessionToken, retryCount + 1);
            }, delay);
        } else {
            showScreen('login-form');
        }
    };
}

// Ping para mantener conexión
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

// Mapa y radar
function initMap() {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado en el DOM");
        alert("Error: No se puede cargar el mapa. Contenedor no encontrado.");
        return;
    }
    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer('https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=YOUR_MAPBOX_ACCESS_TOKEN', {
            maxZoom: 18,
            tileSize: 512,
            zoomOffset: -1,
            attribution: '© Mapbox © OpenStreetMap'
        }).addTo(map);
        console.log("Mapa inicializado con Mapbox");
        map.invalidateSize();
    } catch (error) {
        console.error("Error al inicializar Leaflet:", error);
        alert("Error al cargar el mapa. Verifica tu conexión o recarga la página.");
    }
}

function updateOpenSkyData(flightsData) {
    if (!map) return;
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    let flightPaths = {};
    Object.values(flightPaths).forEach(path => map.removeLayer(path));

    const planeIcon = L.icon({
        iconUrl: '/templates/airplane.png',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });

    flightsData.forEach(flight => {
        if (flight.lat && flight.lon) {
            const marker = L.Marker.movingMarker(
                [[flight.lat, flight.lon], [flight.lat, flight.lon]],
                [10000],
                { icon: planeIcon, rotationAngle: flight.heading || 0 }
            ).addTo(map);
            marker.flight = flight.flight;
            marker.registration = flight.registration;
            marker.bindPopup(
                `Vuelo: ${flight.flight}<br>` +
                `Destino: ${flight.destination || 'N/A'}<br>` +
                `Estado: ${flight.status || 'Desconocido'}<br>` +
                `Altitud: ${flight.alt_geom ? Math.round(flight.alt_geom) : 'N/A'} ft<br>` +
                `Velocidad: ${flight.gs ? Math.round(flight.gs) : 'N/A'} kts`
            );
            markers.push(marker);
            flightPaths[flight.flight] = L.polyline([[flight.lat, flight.lon]], { color: 'blue' }).addTo(map);
        }
    });

    const airplaneIcon = L.icon({
        iconUrl: '/templates/airport.png',
        iconSize: [30, 30],
    });
    const aeroparqueMarker = L.marker([-34.5597, -58.4116], { icon: airplaneIcon })
        .addTo(map)
        .bindPopup("Aeroparque")
        .openPopup();
    markers.push(aeroparqueMarker);
}

function updateFlightPositions(flightsData) {
    flightsData.forEach(flight => {
        if (flight.lat && flight.lon) {
            const marker = markers.find(m => m.flight === flight.flight);
            if (marker) {
                marker.moveTo([flight.lat, flight.lon], 10000);
                marker.setRotationAngle(flight.heading || 0);
                const path = flightPaths[flight.flight];
                if (path) {
                    path.addLatLng([flight.lat, flight.lon]);
                }
            }
        }
    });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c / 1000;
}

function estimateArrivalTime(lat, lon, speed) {
    const aeroparqueLat = -34.5597;
    const aeroparqueLon = -58.4116;
    const distance = calculateDistance(lat, lon, aeroparqueLat, aeroparqueLon);
    if (!speed || speed <= 0) return "N/A";
    const timeHours = distance / (speed * 1.852);
    const minutes = Math.round(timeHours * 60);
    return minutes <= 0 ? "Inmediato" : `${minutes} min`;
}

function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 1000 && speed < 50) return "En tierra";
    if (altitude >= 1000 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "Aterrizando";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

function filterFlights() {
    const searchTerm = document.getElementById("search-bar").value.toUpperCase().trim();
    markers.forEach(marker => {
        const flight = marker.flight || "";
        const registration = marker.registration || "";
        const matchesSearch =
            registration.toUpperCase().includes(searchTerm) ||
            flight.toUpperCase().includes(searchTerm) ||
            searchTerm === "";
        if (matchesSearch) {
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
}

// Grabación de audio
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!talkButton) return;

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        stream = await requestMicPermission();
        if (!stream) return;

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
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
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción: " + event.error;
            };
            try {
                recognition.start();
            } catch (err) {
                console.error("Error al iniciar SpeechRecognition:", err);
            }
        }

        mediaRecorder.ondataavailable = function(event) {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = function() {
            if (audioChunks.length === 0) {
                console.error("No se capturaron fragmentos de audio");
                alert("No se grabó ningún audio. Verifica tu micrófono.");
                return;
            }
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            if (audioBlob.size === 0) {
                console.error("Audio Blob vacío");
                alert("El audio grabado está vacío. Verifica tu micrófono.");
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = function() {
                const base64data = reader.result.split(',')[1];
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
                    ws.send(JSON.stringify(message));
                } else {
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
                }
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

        try {
            mediaRecorder.start(100);
            talkButton.classList.add("recording");
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            stream.getTracks().forEach(track => track.stop());
        }
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.classList.remove("recording");
    }
}

async function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) return;

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
            })
            .catch(err => {
                console.error('Error al acceder al micrófono:', err);
                alert('No se pudo acceder al micrófono. Verifica los permisos.');
            });
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.classList.remove("recording");
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
    } else {
        queueMessageForSync(message);
    }
            }

// Muteo
function toggleMute() {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (muteButton.classList.contains("active")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        muteButton.classList.remove("active");
        if (groupMuteButton) groupMuteButton.classList.remove("active");
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        muteButton.classList.add("active");
        if (groupMuteButton) groupMuteButton.classList.add("active");
    }
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById("group-mute");
    const muteButton = document.getElementById("mute");
    if (groupMuteButton.classList.contains("active")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        groupMuteButton.classList.remove("active");
        if (muteButton) muteButton.classList.remove("active");
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        groupMuteButton.classList.add("active");
        if (muteButton) muteButton.classList.add("active");
    }
}

function updateMuteButton(isMuted) {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (isMuted) {
        muteButton.classList.remove("active");
        if (groupMuteButton) groupMuteButton.classList.remove("active");
    } else {
        muteButton.classList.add("active");
        if (groupMuteButton) groupMuteButton.classList.add("active");
    }
}

function toggleMuteNonGroup() {
    const nonGroupMuteButton = document.getElementById("mute-non-group");
    const isMuting = !nonGroupMuteButton.classList.contains("muted");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuting ? "mute_non_group" : "unmute_non_group", group_id: currentGroup }));
    }
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
    } else {
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
    }
}

// Usuarios
function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) return;

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
        let displayText = user.display || user.user_id;
        if (displayText === user.user_id) {
            const parts = user.user_id.split('_');
            if (parts.length === 3) {
                const [, name, userFunction] = parts;
                displayText = `${name} (${userFunction})`;
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
}

// Grupos
function createGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
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
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
    }
}

function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        localStorage.removeItem('groupId');
        document.getElementById('group-screen').classList.add('slide-right');
        setTimeout(() => {
            document.getElementById('group-screen').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            document.getElementById('group-screen').classList.remove('slide-right');
            document.getElementById('group-chat-list').innerHTML = '';
            document.getElementById('group-flight-details').innerHTML = '';
            const logoutButton = document.getElementById('logout-button');
            if (logoutButton) logoutButton.style.display = 'block';
            updateSwipeHint();
        }, 300);
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
    if (!swipeHint || !returnToGroupBtn) return;

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

// Navegación
function showRadar() {
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function showGroupRadar() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
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
    document.getElementById("history-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    loadHistory();
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
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
}

// Historial
function loadHistory() {
    fetch('/api/history')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error al cargar historial: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const historyList = document.getElementById("history-list");
            if (!historyList) return;
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
                }
                historyList.appendChild(msgDiv);
            });
        })
        .catch(err => {
            console.error("Error al cargar historial:", err);
            const historyList = document.getElementById("history-list");
            if (historyList) {
                historyList.innerHTML = "<div>Error al cargar el historial</div>";
            }
        });
}

// Auxiliares
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
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    if (groupMediaRecorder) {
        groupMediaRecorder.stop();
        groupMediaRecorder = null;
    }
    localStorage.clear();
    currentGroup = null;
    mutedUsers.clear();
    clearInterval(reconnectInterval);
    stopPing();
    showScreen('login-form');
}

// Service Worker y notificaciones
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        fetch('/templates/sw.js', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    navigator.serviceWorker.register('/templates/sw.js')
                        .then(() => console.log('Service Worker registrado'))
                        .catch(err => console.error('Error al registrar Service Worker:', err));
                }
            })
            .catch(err => {
                console.warn('No se pudo verificar sw.js:', err);
            });
    }
}

function checkNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            console.log('Permiso de notificación concedido');
            // subscribeToPush();
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Permiso de notificación concedido');
                    // subscribeToPush();
                }
            });
        }
    }
}

/* Comentado: Notificaciones push
function subscribeToPush() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array('YOUR_PUBLIC_VAPID_KEY')
            }).then(subscription => {
                fetch('/subscribe', {
                    method: 'POST',
                    body: JSON.stringify(subscription),
                    headers: { 'Content-Type': 'application/json' }
                });
            });
        });
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
*/
    

