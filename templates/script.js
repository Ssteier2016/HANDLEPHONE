document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('refresh-btn');
  const flightsBody = document.getElementById('flights-body');
  const airportName = document.getElementById('airport-name');

  // Función para obtener y mostrar los vuelos
  async function fetchFlights() {
    try {
      const response = await fetch('/flights');
      const data = await response.json();

      if (data.error) {
        flightsBody.innerHTML = `<tr><td colspan="6">Error: ${data.error}</td></tr>`;
        return;
      }

      const flights = data.flights || [];
      if (flights.length === 0) {
        // Cambia "MIA" por "AEP" cuando vuelvas a Aeroparque
        airportName.textContent = "Miami International (MIA)";
        flightsBody.innerHTML = '<tr><td colspan="6">No se encontraron vuelos para MIA.</td></tr>';
        return;
      }

      // Actualizar el nombre del aeropuerto basado en los datos
      // Cambia "MIA" por "AEP" cuando vuelvas a Aeroparque
      airportName.textContent = "Miami International (MIA)";

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
      flightsBody.innerHTML = `<tr><td colspan="6">Error al cargar los vuelos: ${error.message}</td></tr>`;
    }
  }

  // Cargar vuelos al iniciar
  fetchFlights();

  // Actualizar vuelos al hacer clic en el botón
  refreshBtn.addEventListener('click', fetchFlights);
});
