let ws = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isMuted = false;
let token = null;
let currentGroup = null;
let mutedUsers = new Set();
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectInterval = 5000; // 5 segundos
const messageQueue = [];
let isOnline = navigator.onLine;

// Elementos del DOM
const loginScreen = document.getElementById('login-screen');
const mainScreen = document.getElementById('main-screen');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const registerScreen = document.getElementById('register-screen');
const showRegisterButton = document.getElementById('show-register');
const backToLoginButton = document.getElementById('back-to-login');
const messages = document.getElementById('messages');
const usersList = document.getElementById('users-list');
const flightList = document.getElementById('flight-list');
const flightDetails = document.getElementById('flight-details');
const groupList = document.getElementById('group-list');
const sendButton = document.getElementById('send-button');
const muteButton = document.getElementById('mute-button');
const groupButton = document.getElementById('group-button');
const searchInput = document.getElementById('search-input');
const createGroupButton = document.getElementById('create-group-button');
const joinGroupButton = document.getElementById('join-group-button');
const leaveGroupButton = document.getElementById('leave-group-button');
const muteAllButton = document.getElementById('mute-all-button');
const unmuteAllButton = document.getElementById('unmute-all-button');
const logoutButton = document.getElementById('logout-button');
const errorMessage = document.getElementById('error-message');
const registerErrorMessage = document.getElementById('register-error-message');
const groupModal = document.getElementById('group-modal');
const closeModal = document.getElementById('close-modal');
const groupNameInput = document.getElementById('group-name');
const flightDetailsModal = document.getElementById('flight-details-modal');
const closeFlightDetails = document.getElementById('close-flight-details');

// Estado de la aplicación
let globalMuteActive = false;

// Verificar conexión a internet
window.addEventListener('online', () => {
    isOnline = true;
    console.log('Conexión a internet restaurada');
    reconnectWebSocket();
});
window.addEventListener('offline', () => {
    isOnline = false;
    console.log('Sin conexión a internet');
    if (ws) ws.close();
});

// Manejar login
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const surname = document.getElementById('surname').value;
    const employeeId = document.getElementById('employee-id').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id: employeeId, password })
        });
        const data = await response.json();
        if (response.ok) {
            token = data.token;
            localStorage.setItem('token', token);
            localStorage.setItem('surname', surname);
            localStorage.setItem('sector', data.sector || 'Desconocido');
            connectWebSocket();
            loginScreen.style.display = 'none';
            mainScreen.style.display = 'block';
            loadFlights();
            loadHistory();
        } else {
            errorMessage.textContent = data.detail || 'Error al iniciar sesión';
        }
    } catch (err) {
        errorMessage.textContent = 'Error de conexión';
        console.error('Error en login:', err);
    }
});

// Manejar registro
registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const surname = document.getElementById('register-surname').value;
    const employeeId = document.getElementById('register-employee-id').value;
    const sector = document.getElementById('register-sector').value;
    const password = document.getElementById('register-password').value;

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id: employeeId, sector, password })
        });
        const data = await response.json();
        if (response.ok) {
            registerScreen.style.display = 'none';
            loginScreen.style.display = 'block';
            errorMessage.textContent = 'Registro exitoso, por favor inicia sesión';
        } else {
            registerErrorMessage.textContent = data.detail || 'Error al registrar';
        }
    } catch (err) {
        registerErrorMessage.textContent = 'Error de conexión';
        console.error('Error en registro:', err);
    }
});

// Mostrar pantalla de registro
showRegisterButton.addEventListener('click', () => {
    loginScreen.style.display = 'none';
    registerScreen.style.display = 'block';
});

// Volver a login
backToLoginButton.addEventListener('click', () => {
    registerScreen.style.display = 'none';
    loginScreen.style.display = 'block';
});

// Conectar WebSocket
function connectWebSocket() {
    if (!token || !isOnline) {
        console.log('No se puede conectar WebSocket: sin token o sin conexión');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws/${token}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket conectado');
        reconnectAttempts = 0;
        sendPing();
        processMessageQueue();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (err) {
            console.error('Error al parsear mensaje WebSocket:', err);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket desconectado');
        if (isOnline && reconnectAttempts < maxReconnectAttempts) {
            setTimeout(reconnectWebSocket, reconnectInterval);
            reconnectAttempts++;
        } else {
            mainScreen.style.display = 'none';
            loginScreen.style.display = 'block';
            errorMessage.textContent = 'Conexión perdida, por favor inicia sesión nuevamente';
        }
    };

    ws.onerror = (err) => {
        console.error('Error WebSocket:', err);
        ws.close();
    };
}

// Reconectar WebSocket
function reconnectWebSocket() {
    if (isOnline && token) {
        console.log('Intentando reconectar WebSocket...');
        connectWebSocket();
    }
}

// Enviar ping
function sendPing() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
    setTimeout(sendPing, 30000); // Cada 30 segundos
}

// Manejar mensajes WebSocket
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'connection_success':
            console.log('Conexión WebSocket exitosa');
            ws.send(JSON.stringify({ type: 'subscribe', subscription: 'all' }));
            break;
        case 'audio':
            if (!globalMuteActive && !mutedUsers.has(`${data.sender}_${data.function}`)) {
                addMessage(data);
                playAudio(data.data);
            }
            break;
        case 'group_message':
            if (currentGroup === data.group_id && !globalMuteActive && !mutedUsers.has(`${data.sender}_${data.function}`)) {
                addMessage(data);
                playAudio(data.data);
            }
            break;
        case 'users':
            updateUsersList(data.list);
            break;
        case 'flight_update':
            updateFlightList(data.flights);
            break;
        case 'search_response':
            addMessage({ sender: 'Sistema', function: 'Búsqueda', text: data.message, timestamp: new Date().toLocaleTimeString() });
            break;
        case 'flight_details_response':
            showFlightDetails(data.flight);
            break;
        case 'flight_details_error':
            addMessage({ sender: 'Sistema', function: 'Error', text: data.message, timestamp: new Date().toLocaleTimeString() });
            break;
        case 'mute_state':
            globalMuteActive = data.global_mute_active;
            muteButton.src = globalMuteActive ? '/templates/mic-off.png' : '/templates/mic-on.png';
            break;
        case 'mute_notification':
            addMessage({ sender: 'Sistema', function: 'Notificación', text: data.message, timestamp: new Date().toLocaleTimeString() });
            break;
        case 'create_group_success':
            currentGroup = data.group_id;
            updateGroupList();
            groupModal.style.display = 'none';
            break;
        case 'join_group':
            currentGroup = data.group_id;
            updateGroupList();
            groupModal.style.display = 'none';
            break;
        case 'leave_group_success':
            currentGroup = null;
            updateGroupList();
            break;
        case 'logout_success':
            logout();
            break;
        case 'error':
            addMessage({ sender: 'Sistema', function: 'Error', text: data.message, timestamp: new Date().toLocaleTimeString() });
            break;
        case 'SYNC_COMPLETE':
            console.log('Sincronización completada');
            processMessageQueue();
            break;
    }
}

// Agregar mensaje al DOM
function addMessage(data) {
    const li = document.createElement('li');
    li.textContent = `[${data.timestamp}] ${data.sender} (${data.function}): ${data.text}`;
    messages.appendChild(li);
    messages.scrollTop = messages.scrollHeight;
}

// Reproducir audio recibido
function playAudio(base64Audio) {
    try {
        const audio = new Audio(`data:audio/webm;base64,${base64Audio}`);
        audio.play().catch(err => console.error('Error al reproducir audio:', err));
    } catch (err) {
        console.error('Error al procesar audio:', err);
    }
}

// Cargar historial de mensajes
async function loadHistory() {
    try {
        const response = await fetch('/api/history');
        const history = await response.json();
        history.forEach(data => {
            addMessage({
                sender: data.user_id.split('_')[0],
                function: data.user_id.split('_')[1] || 'Desconocido',
                text: data.text,
                timestamp: data.timestamp
            });
        });
    } catch (err) {
        console.error('Error al cargar historial:', err);
    }
}

// Cargar vuelos
async function loadFlights(query = '') {
    try {
        const response = await fetch(`/api/flights${query ? `?query=${encodeURIComponent(query)}` : ''}`);
        const data = await response.json();
        updateFlightList(data.flights);
    } catch (err) {
        console.error('Error al cargar vuelos:', err);
        addMessage({ sender: 'Sistema', function: 'Error', text: 'Error al cargar vuelos', timestamp: new Date().toLocaleTimeString() });
    }
}

// Actualizar lista de vuelos
function updateFlightList(flights) {
    flightList.innerHTML = '';
    flights.forEach(flight => {
        const li = document.createElement('li');
        const sourceTag = flight.source === 'flightradar24' ? '[FR24]' : '[GFL]';
        li.innerHTML = `
            ${flight.flight_number} - ${flight.origin} a ${flight.destination} (${flight.status})
            <span class="flight-source">${sourceTag}</span>
        `;
        li.addEventListener('click', () => requestFlightDetails(flight.flight_number));
        flightList.appendChild(li);
    });
}

// Solicitar detalles de un vuelo
function requestFlightDetails(flightNumber) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'flight_details_request', flight_number: flightNumber }));
    } else {
        queueMessage({ type: 'flight_details_request', flight_number: flightNumber });
    }
}

// Mostrar detalles de un vuelo
function showFlightDetails(flight) {
    const sourceTag = flight.source === 'flightradar24' ? '[FR24]' : '[GFL]';
    flightDetails.innerHTML = `
        <h3>Vuelo ${flight.flight_number} ${sourceTag}</h3>
        <p>Origen: ${flight.origin}</p>
        <p>Destino: ${flight.destination}</p>
        <p>Salida: ${flight.departure_time || 'N/A'}</p>
        <p>Llegada: ${flight.arrival_time || 'N/A'}</p>
        <p>Estado: ${flight.status}</p>
        <p>Puerta: ${flight.gate}</p>
        <p>Retraso: ${flight.delay} minutos</p>
        <p>Matrícula: ${flight.registration}</p>
    `;
    flightDetailsModal.style.display = 'block';
}

// Actualizar lista de usuarios
function updateUsersList(users) {
    usersList.innerHTML = '';
    users.forEach(user => {
        const li = document.createElement('li');
        const muteStatus = mutedUsers.has(user.user_id) ? 'Desmutear' : 'Mutear';
        li.innerHTML = `
            ${user.display} ${user.group_id ? `(Grupo: ${user.group_id})` : ''}
            <button onclick="toggleMuteUser('${user.user_id}')">${muteStatus}</button>
        `;
        usersList.appendChild(li);
    });
}

// Alternar muteo de usuario
function toggleMuteUser(userId) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        ws.send(JSON.stringify({ type: 'unmute_user', target_user_id: userId }));
    } else {
        mutedUsers.add(userId);
        ws.send(JSON.stringify({ type: 'mute_user', target_user_id: userId }));
    }
    updateUsersList(usersList.querySelectorAll('li').map(li => ({
        user_id: li.querySelector('button').onclick.toString().match(/'([^']+)'/)[1],
        display: li.textContent.split(' (')[0],
        group_id: li.textContent.includes('Grupo:') ? li.textContent.match(/Grupo: ([^)]+)/)[1] : null
    })));
}

// Actualizar lista de grupos
function updateGroupList() {
    groupList.innerHTML = '';
    if (currentGroup) {
        const li = document.createElement('li');
        li.textContent = `Grupo actual: ${currentGroup}`;
        groupList.appendChild(li);
    }
}

// Manejar grabación de audio
sendButton.addEventListener('mousedown', startRecording);
sendButton.addEventListener('mouseup', stopRecording);
sendButton.addEventListener('touchstart', startRecording);
sendButton.addEventListener('touchend', stopRecording);

async function startRecording(e) {
    e.preventDefault();
    if (isRecording || globalMuteActive) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                const base64Audio = reader.result.split(',')[1];
                const message = {
                    type: currentGroup ? 'group_message' : 'audio',
                    data: base64Audio,
                    text: 'Pendiente de transcripción',
                    timestamp: new Date().toLocaleTimeString(),
                    sender: localStorage.getItem('surname') || 'Anónimo',
                    function: localStorage.getItem('sector') || 'Desconocido',
                    group_id: currentGroup
                };
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                } else {
                    queueMessage(message);
                }
            };
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        sendButton.classList.add('recording');
    } catch (err) {
        console.error('Error al iniciar grabación:', err);
        addMessage({ sender: 'Sistema', function: 'Error', text: 'Error al grabar audio', timestamp: new Date().toLocaleTimeString() });
    }
}

function stopRecording() {
    if (isRecording && mediaRecorder) {
        mediaRecorder.stop();
        isRecording = false;
        sendButton.classList.remove('recording');
    }
}

// Manejar muteo
muteButton.addEventListener('click', () => {
    isMuted = !isMuted;
    muteButton.src = isMuted ? '/templates/mic-off.png' : '/templates/mic-on.png';
    ws.send(JSON.stringify({ type: isMuted ? 'mute' : 'unmute' }));
});

// Manejar muteo global
muteAllButton.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'mute_all' }));
});
unmuteAllButton.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'unmute_all' }));
});

// Manejar grupos
groupButton.addEventListener('click', () => {
    groupModal.style.display = 'block';
});

closeModal.addEventListener('click', () => {
    groupModal.style.display = 'none';
});

createGroupButton.addEventListener('click', () => {
    const groupName = groupNameInput.value.trim();
    if (groupName) {
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupName, is_private: false }));
        groupNameInput.value = '';
    }
});

joinGroupButton.addEventListener('click', () => {
    const groupName = groupNameInput.value.trim();
    if (groupName) {
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupName, is_private: false }));
        groupNameInput.value = '';
    }
});

leaveGroupButton.addEventListener('click', () => {
    if (currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group' }));
    }
});

// Manejar búsqueda
searchInput.addEventListener('input', debounce(async (e) => {
    const query = e.target.value.trim();
    if (query.length >= 2) { // Evitar búsquedas con menos de 2 caracteres
        await loadFlights(query);
    } else {
        await loadFlights(); // Cargar todos los vuelos si la consulta es vacía o muy corta
    }
}, 300));

// Función debounce para limitar la frecuencia de eventos
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Manejar logout
logoutButton.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'logout' }));
    } else {
        logout();
    }
});

function logout() {
    token = null;
    currentGroup = null;
    mutedUsers.clear();
    localStorage.removeItem('token');
    localStorage.removeItem('surname');
    localStorage.removeItem('sector');
    if (ws) {
        ws.close();
        ws = null;
    }
    mainScreen.style.display = 'none';
    loginScreen.style.display = 'block';
    messages.innerHTML = '';
    usersList.innerHTML = '';
    flightList.innerHTML = '';
    groupList.innerHTML = '';
    flightDetailsModal.style.display = 'none';
    groupModal.style.display = 'none';
    errorMessage.textContent = 'Sesión cerrada';
}

// Manejar cola de mensajes
function queueMessage(message) {
    messageQueue.push(message);
    console.log('Mensaje encolado:', message);
}

function processMessageQueue() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        while (messageQueue.length > 0) {
            const message = messageQueue.shift();
            ws.send(JSON.stringify(message));
            console.log('Mensaje enviado desde cola:', message);
        }
    }
}

// Cerrar modales al hacer clic fuera
window.addEventListener('click', (e) => {
    if (e.target === groupModal) {
        groupModal.style.display = 'none';
    }
    if (e.target === flightDetailsModal) {
        flightDetailsModal.style.display = 'none';
    }
});

// Cerrar modal de detalles de vuelo
closeFlightDetails.addEventListener('click', () => {
    flightDetailsModal.style.display = 'none';
});

// Inicializar aplicación
function init() {
    token = localStorage.getItem('token');
    if (token && isOnline) {
        connectWebSocket();
        loginScreen.style.display = 'none';
        mainScreen.style.display = 'block';
        loadFlights();
        loadHistory();
    } else {
        loginScreen.style.display = 'block';
        mainScreen.style.display = 'none';
    }
}

// Ejecutar inicialización
init();
