document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const flightsBody = document.getElementById('flights-body');
  const airportName = document.getElementById('airport-name');

  if (!refreshBtn || !flightsBody || !airportName) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      flightsBody: !!flightsBody,
      airportName: !!airportName
    });
    return;
  }

  // Función para obtener y mostrar los vuelos
  async function fetchFlights() {
    try {
      console.log("Haciendo solicitud a /flights...");
      const response = await fetch('/flights');
      console.log("Respuesta recibida:", response);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("Datos recibidos:", data);

      if (data.error) {
        flightsBody.innerHTML = `<tr><td colspan="6">Error: ${data.error}</td></tr>`;
        return;
      }

      const flights = data.flights || [];
      if (flights.length === 0) {
        // Cambia "MIA" por "AEP" cuando vuelvas a Aeroparque
        airportName.textContent = "Aeroparque Jorge Newbery (AEP)";
        flightsBody.innerHTML = '<tr><td colspan="6">No se encontraron vuelos para MIA.</td></tr>';
        return;
      }

      // Actualizar el nombre del aeropuerto basado en los datos
      // Cambia "MIA" por "AEP" cuando vuelvas a Aeroparque
      airportName.textContent = "Aeroparque Jorge Newbery (AEP)";

      // Limpiar tabla
      flightsBody.innerHTML = '';

      // Llenar tabla con datos de vuelos
      flights.forEach(flight => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${flight.flight_iata}</td>
          <td>${flight.airline_iata}</td>
          <td>${flight.departure}</td>
          <td>${flight.arrival}</td>
          <td>${flight.status}</td>
          <td>${new Date(flight.updated * 1000).toLocaleString('es-AR')}</td>
        `;
        flightsBody.appendChild(row);
      });
    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="6">Error al cargar los vuelos: ${error.message}</td></tr>`;
    }
  }

  // Cargar vuelos al iniciar
  console.log("Cargando vuelos al iniciar...");
  fetchFlights();

  // Actualizar vuelos al hacer clic en el botón
  refreshBtn.addEventListener('click', () => {
    console.log("Botón de actualizar clicado");
    fetchFlights();
  });
});
