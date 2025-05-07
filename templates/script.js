document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  // Elementos del DOM
  const introScreen = document.getElementById('intro-screen');
  const loginFormScreen = document.getElementById('login-form');
  const recoverFormScreen = document.getElementById('recover-form');
  const registerFormScreen = document.getElementById('register-form');
  const mainScreen = document.getElementById('main');
  const loginForm = document.getElementById('login-form-form');
  const recoverForm = document.getElementById('recover-form-form');
  const registerForm = document.getElementById('register-form-form');
  const loginError = document.getElementById('login-error');
  const recoverError = document.getElementById('recover-error');
  const registerError = document.getElementById('register-error');
  const showRecoverLink = document.getElementById('show-recover');
  const showRegisterLink = document.getElementById('show-register');
  const showLoginLinks = document.querySelectorAll('#show-login');
  const logoutButton = document.getElementById('logout-button');
  const chatList = document.getElementById('chat-list');
  const chatInput = document.getElementById('chat-input');
  const sendChatButton = document.getElementById('send-chat');
  const talkButton = document.getElementById('talk');

  // Variables de estado
  let currentUser = null;
  let mediaRecorder = null;
  let audioStream = null;
  let isRecording = false;
  let socket = null;
  let mutedUsers = new Set(); // Usuarios muteados selectivamente
  let isGlobalMute = false; // Estado del mute global

  // Mostrar u ocultar pantallas
  function showScreen(screenId) {
    const screens = [introScreen, loginFormScreen, recoverFormScreen, registerFormScreen, mainScreen];
    screens.forEach(screen => {
      if (screen) screen.style.display = 'none';
    });
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) targetScreen.style.display = 'block';
  }

  // Validar contraseñas al registrarse
  function validatePasswords(password, confirmPassword) {
    if (password !== confirmPassword) {
      return "Las contraseñas no coinciden.";
    }
    if (password.length < 6) {
      return "La contraseña debe tener al menos 6 caracteres.";
    }
    return null;
  }

  // Simular almacenamiento de usuarios (usando localStorage)
  function getUsers() {
    const users = localStorage.getItem('users');
    return users ? JSON.parse(users) : {};
  }

  function saveUser(name, password) {
    const users = getUsers();
    users[name] = { password };
    localStorage.setItem('users', JSON.stringify(users));
  }

  // Inicio de sesión
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('login-name').value.trim();
    const password = document.getElementById('login-password').value;

    const users = getUsers();
    if (!users[name]) {
      loginError.textContent = "Usuario no encontrado.";
      return;
    }
    if (users[name].password !== password) {
      loginError.textContent = "Contraseña incorrecta.";
      return;
    }

    loginError.textContent = "";
    currentUser = name;
    localStorage.setItem('currentUser', name);
    showScreen('main');
    initializeChat();
  });

  // Registro
  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('register-name').value.trim();
    const password = document.getElementById('register-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    const users = getUsers();
    if (users[name]) {
      registerError.textContent = "El usuario ya existe.";
      return;
    }

    const passwordError = validatePasswords(password, confirmPassword);
    if (passwordError) {
      registerError.textContent = passwordError;
      return;
    }

    saveUser(name, password);
    registerError.textContent = "Registro exitoso. Inicia sesión.";
    showScreen('login-form');
  });

  // Recuperación de contraseña (simulada)
  recoverForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('recover-name').value.trim();

    const users = getUsers();
    if (!users[name]) {
      recoverError.textContent = "Usuario no encontrado.";
      return;
    }

    // Simulación: mostramos la contraseña actual (en un entorno real, enviaríamos un enlace por email)
    recoverError.textContent = `Tu contraseña actual es: ${users[name].password}. Por favor, inicia sesión.`;
    setTimeout(() => showScreen('login-form'), 5000);
  });

  // Navegación entre pantallas
  showRecoverLink.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('recover-form');
  });

  showRegisterLink.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('register-form');
  });

  showLoginLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('login-form');
    });
  });

  logoutButton.addEventListener('click', () => {
    currentUser = null;
    localStorage.removeItem('currentUser');
    if (socket) {
      socket.disconnect();
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
    }
    showScreen('login-form');
  });

  // Inicializar el chat con Socket.IO
  function initializeChat() {
    socket = io('http://localhost:5000'); // Ajusta la URL según tu backend

    socket.on('connect', () => {
      console.log("Conectado al servidor de chat");
      socket.emit('join', { username: currentUser });
    });

    socket.on('chat_message', (data) => {
      if (isGlobalMute || mutedUsers.has(data.username)) return; // Ignorar si está muteado
      const messageDiv = document.createElement('div');
      messageDiv.classList.add('chat-message');
      messageDiv.innerHTML = `<strong>${data.username}:</strong> ${data.message}`;
      
      // Agregar botón de mute selectivo
      const muteButton = document.createElement('button');
      muteButton.textContent = mutedUsers.has(data.username) ? 'Desmutear' : 'Mutear';
      muteButton.classList.add('mute-btn');
      muteButton.addEventListener('click', () => toggleMuteUser(data.username, muteButton));
      messageDiv.appendChild(muteButton);
      
      chatList.appendChild(messageDiv);
      chatList.scrollTop = chatList.scrollHeight;
    });

    socket.on('audio_message', (data) => {
      if (isGlobalMute || mutedUsers.has(data.username)) return; // Ignorar si está muteado
      const audio = new Audio(URL.createObjectURL(new Blob([data.audio], { type: 'audio/webm' })));
      audio.play();
      
      const messageDiv = document.createElement('div');
      messageDiv.classList.add('chat-message');
      messageDiv.innerHTML = `<strong>${data.username}:</strong> [Mensaje de voz]`;
      
      const muteButton = document.createElement('button');
      muteButton.textContent = mutedUsers.has(data.username) ? 'Desmutear' : 'Mutear';
      muteButton.classList.add('mute-btn');
      muteButton.addEventListener('click', () => toggleMuteUser(data.username, muteButton));
      messageDiv.appendChild(muteButton);
      
      chatList.appendChild(messageDiv);
      chatList.scrollTop = chatList.scrollHeight;
    });
  }

  // Enviar mensaje de texto
  sendChatButton.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (message && socket) {
      socket.emit('chat_message', { username: currentUser, message });
      chatInput.value = '';
    }
  });

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendChatButton.click();
    }
  });

  // Manejar el micrófono
  talkButton.addEventListener('click', async () => {
    if (!isRecording) {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        const audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
          audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          socket.emit('audio_message', { username: currentUser, audio: audioBlob });
          audioStream.getTracks().forEach(track => track.stop());
          audioStream = null;
          mediaRecorder = null;
        };

        mediaRecorder.start();
        isRecording = true;
        talkButton.src = '/templates/mic-on.png';
        talkButton.alt = 'Micrófono encendido';
      } catch (error) {
        console.error("Error al acceder al micrófono:", error);
        alert("No se pudo acceder al micrófono. Verifica los permisos.");
      }
    } else {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
      isRecording = false;
      talkButton.src = '/templates/mic-off.png';
      talkButton.alt = 'Micrófono apagado';
    }
  });

  // Mutear/desmutear a un usuario específico
  function toggleMuteUser(username, button) {
    if (mutedUsers.has(username)) {
      mutedUsers.delete(username);
      button.textContent = 'Mutear';
    } else {
      mutedUsers.add(username);
      button.textContent = 'Desmutear';
    }
  }

  // Mutear/desmutear a todos (mute global)
  const globalMuteButton = document.createElement('button');
  globalMuteButton.id = 'global-mute';
  globalMuteButton.textContent = 'Mutear a Todos';
  globalMuteButton.classList.add('mute-btn');
  mainScreen.appendChild(globalMuteButton);

  globalMuteButton.addEventListener('click', () => {
    isGlobalMute = !isGlobalMute;
    globalMuteButton.textContent = isGlobalMute ? 'Desmutear a Todos' : 'Mutear a Todos';
  });

  // Verificar si hay un usuario logueado al cargar la página
  const savedUser = localStorage.getItem('currentUser');
  if (savedUser) {
    currentUser = savedUser;
    showScreen('main');
    initializeChat();
  }
});
