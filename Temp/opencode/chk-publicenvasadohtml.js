        const rolUsuario = localStorage.getItem('rol_actual');
        if (!rolUsuario || (rolUsuario !== 'envasado' && rolUsuario !== 'supervisor' && rolUsuario !== 'produccion')) {
            alert('❌ Acceso no autorizado.');
            window.location.href = 'index.html';
        }
        if (rolUsuario !== 'supervisor' && rolUsuario !== 'produccion') {
            document.getElementById('linkDashboard').style.display = 'none';
        }

        document.getElementById('fecha_produccion').valueAsDate = new Date();
        let reportesGlobal = [];

        const PRESENTACIONES_ENVASADO = [
            { v: 'Aceite de Soya B-1 200 ml', l: 'Aceite de Soya B-1 200 ml (Cajas x 24)' },
            { v: 'Aceite de Soya B-1 500 ml', l: 'Aceite de Soya B-1 500 ml (Cajas x 12)' },
            { v: 'Aceite de Soya B-1 900 ml', l: 'Aceite de Soya B-1 900 ml (Cajas x 12)' },
            { v: 'Aceite de Soya B-1 1 Lt', l: 'Aceite de Soya B-1 1 Lt (Cajas x 12)' },
            { v: 'Aceite de Soya B-1 2 Lt', l: 'Aceite de Soya B-1 2 Lt (Cajas x 6)' },
            { v: 'Aceite de Soya B-1 5 Lt (Galonera)', l: 'Aceite de Soya B-1 5 Lt (Galonera x 4)' },
            { v: 'Aceite de Soya Don Lalo 800 ml', l: 'Aceite de Soya Don Lalo 800 ml (Cajas x 12)' },
            { v: 'Aceite de Soya Don Lalo Balde 20 Lt', l: 'Aceite de Soya Don Lalo Balde 20 Lt' },
            { v: 'Aceite de Soya Belini 200 ml', l: 'Aceite de Soya Belini 200 ml (Cajas x 24)' },
            { v: 'Aceite de Soya Belini 500 ml', l: 'Aceite de Soya Belini 500 ml (Cajas x 12)' },
            { v: 'Aceite de Soya Belini 900 ml', l: 'Aceite de Soya Belini 900 ml (Cajas x 12)' },
            { v: 'Aceite de Soya Belini 1 Lt', l: 'Aceite de Soya Belini 1 Lt (Cajas x 12)' },
            { v: 'Aceite de Soya Belini 2 Lt (Galonera)', l: 'Aceite de Soya Belini 2 Lt (Galonera x 6)' },
            { v: 'Aceite de Soya Belini 3 Lt', l: 'Aceite de Soya Belini 3 Lt (Cajas x 4)' },
            { v: 'Aceite de Soya Belini 5 Lt (Galonera)', l: 'Aceite de Soya Belini 5 Lt (Galonera x 4)' },
            { v: 'Aceite de Soya Belini Lata 18 Lt', l: 'Aceite de Soya Belini Lata 18 Lt' },
            { v: 'Aceite de Soya Belini Balde 18 Lt', l: 'Aceite de Soya Belini Balde 18 Lt' }
        ];

        function poblarSelectsEnvasado() {
            const selForm = document.getElementById('presentacion');
            const selSig = document.getElementById('siguienteSelect');
            if (selForm) {
                selForm.innerHTML = '<option value="">-- Seleccionar Presentación --</option>' +
                    PRESENTACIONES_ENVASADO.map(p => `<option value="${p.v}">${p.l}</option>`).join('');
            }
            if (selSig) {
                selSig.innerHTML = '<option value="">-- Sin señalar --</option>' +
                    PRESENTACIONES_ENVASADO.map(p => `<option value="${p.v}">${p.l}</option>`).join('');
            }
        }

        let siguienteProductoEnvasado = '';
        function pintarSiguienteEnvasado() {
            const el = document.getElementById('siguienteEnvasado');
            if (el) {
                el.innerHTML = siguienteProductoEnvasado
                    ? `⏭️ Siguiente: <b>${siguienteProductoEnvasado}</b>`
                    : '⏭️ Siguiente: —';
            }
            const sel = document.getElementById('siguienteSelect');
            if (sel && siguienteProductoEnvasado && PRESENTACIONES_ENVASADO.some(p => p.v === siguienteProductoEnvasado)) {
                sel.value = siguienteProductoEnvasado;
            }
        }

        function pintarAnteriorEnvasado() {
            const el = document.getElementById('anteriorEnvasado');
            if (!el) return;
            const ult = Array.isArray(reportesGlobal) && reportesGlobal.length ? reportesGlobal[0] : null;
            el.innerHTML = ult
                ? `⬅️ Anterior: <b>${ult.presentacion}</b> · <b>${ult.cantidad_cajas}</b> cajas`
                : '⬅️ Anterior: —';
        }

        let enviandoSiguiente = false;
        async function senalarSiguiente() {
            if (enviandoSiguiente) return;
            const sel = document.getElementById('siguienteSelect');
            const valor = sel ? sel.value : '';
            if (!valor) {
                alert('Selecciona un producto para señalar como siguiente.');
                return;
            }
            enviandoSiguiente = true;
            const btn = document.getElementById('btnSenalarSiguiente');
            if (btn) btn.disabled = true;
            try {
                const res = await fetch('/api/estado-linea', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        area: 'envasado',
                        estado: estadoEnvasadoActual,
                        proximo_producto: valor,
                        usuario: localStorage.getItem('usuario_actual') || 'envasado_user'
                    })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    siguienteProductoEnvasado = valor;
                    pintarSiguienteEnvasado();
                    alert('✔ Siguiente señalado: ' + valor);
                } else {
                    alert('❌ ' + (data.mensaje || 'Error al señalar el siguiente producto.'));
                }
            } catch (err) {
                console.error(err);
                alert('Error de conexión con el servidor.');
            } finally {
                enviandoSiguiente = false;
                if (btn) btn.disabled = false;
            }
        }

        function cerrarSesion() {
            if (confirm('¿Estás seguro de que deseas cerrar sesión?')) {
                limpiarSesion();
                window.location.href = 'index.html';
            }
        }

        function mostrarMenu() {
            document.getElementById('menuEnvasado').style.display = 'block';
            document.getElementById('vistaReportar').style.display = 'none';
            document.getElementById('vistaActiva').style.display = 'none';
            cargarProduccionActiva();
        }

        function mostrarVista(vista) {
            document.getElementById('menuEnvasado').style.display = 'none';
            document.getElementById('vistaReportar').style.display = vista === 'reportar' ? 'block' : 'none';
            document.getElementById('vistaActiva').style.display = vista === 'activa' ? 'block' : 'none';
            if (vista === 'activa') cargarProduccionActiva();
        }

        function verificarSeleccionTapa() {
            const presentacion = document.getElementById('presentacion').value;
            const grupoTapa = document.getElementById('grupoTapaDinamica');

            const requiereTapa = presentacion.includes('500 ml') || 
                                 presentacion.includes('900 ml') || 
                                 presentacion.includes('1 Lt') || 
                                 presentacion.includes('800 ml') || 
                                 presentacion.includes('3 Lt');

            if (requiereTapa) {
                grupoTapa.style.display = 'block';
            } else {
                grupoTapa.style.display = 'none';
            }
        }

        function fechaLocalISO(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return String(iso).substring(0, 10);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        function etiquetarTablas() {
            document.querySelectorAll('.tabla-card-movil table').forEach(tabla => {
                const ths = Array.from(tabla.querySelectorAll('thead th'))
                    .map(th => th.textContent.replace(/\s+/g, ' ').trim());
                if (!ths.length) return;
                tabla.querySelectorAll('tbody tr').forEach(fila => {
                    const celdas = Array.from(fila.cells);
                    if (celdas.length !== ths.length) return;
                    celdas.forEach((td, i) => { td.dataset.label = ths[i]; });
                });
            });
        }

        async function cargarProduccionActiva() {
            try {
                const res = await fetch('/api/produccion/reportes');
                if (!res.ok) throw new Error('Error del servidor al cargar producción.');
                const datos = await res.json();
                reportesGlobal = Array.isArray(datos) ? datos : [];
                const tbody = document.getElementById('tablaProduccionActiva');
                
                if (reportesGlobal.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="7" class="text-center">No hay registros activos para el día en curso.</td></tr>`;
                    document.getElementById('totalTmActivo').textContent = '0.00';
                    resumenEstadoEnvasado();
                    return;
                }

                tbody.innerHTML = '';
                let sumaTn = 0;
                reportesGlobal.forEach(row => {
                    const fechaStr = row.fecha_produccion ? fechaLocalISO(row.fecha_produccion) : '';
                    sumaTn += parseFloat(row.toneladas || 0);
                    const presentacionSegura = String(row.presentacion || '').replace(/'/g, "\\'");
                    tbody.innerHTML += `
                        <tr>
                            <td>${fechaStr}</td>
                            <td><b>${row.presentacion}</b></td>
                            <td class="text-center">${row.cantidad_cajas}</td>
                            <td class="text-center">${row.unidad_medida || 'CAJAS'}</td>
                            <td class="text-center">${row.toneladas}</td>
                            <td>${row.observaciones || '-'}</td>
                            <td class="text-center"><button onclick="eliminarReporte(${row.id}, '${presentacionSegura}')" class="btn-comer" title="Eliminar reporte"><span class="ico-papelera"><span class="tapa"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/></svg></span><span class="base"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span></span><span class="texto-papelera"><span class="letra">D</span><span class="letra">e</span><span class="letra">l</span><span class="letra">e</span><span class="letra">t</span><span class="letra">e</span></span></button></td>
                        </tr>
                    `;
                });
                document.getElementById('totalTmActivo').textContent = sumaTn.toFixed(2);
                resumenEstadoEnvasado();
                etiquetarTablas();
            } catch (e) {
                console.error(e);
            }
        }

        let estadoEnvasadoActual = 'PARADO';

        function pintarEstadoEnvasado() {
            const pill = document.getElementById('pillEstadoEnvasado');
            const btn = document.getElementById('btnCambiarEstadoEnvasado');
            if (estadoEnvasadoActual === 'EN MARCHA') {
                pill.className = 'estado-pill marcha';
                pill.textContent = '🟢 EN MARCHA';
                btn.textContent = '🛑 MARCAR PARADO';
            } else {
                pill.className = 'estado-pill parado';
                pill.textContent = '🔴 PARADO';
                btn.textContent = '🟢 MARCAR EN MARCHA';
            }
        }

        function resumenEstadoEnvasado() {
            let totalCajas = 0;
            let totalTn = 0;
            reportesGlobal.forEach(r => {
                totalCajas += parseInt(r.cantidad_cajas || 0, 10);
                totalTn += parseFloat(r.toneladas || 0);
            });
            document.getElementById('totalesEstadoEnvasado').textContent =
                `Hoy: ${totalCajas} cajas · ${totalTn.toFixed(2)} TM · ${reportesGlobal.length} reportes`;
            pintarAnteriorEnvasado();
        }

        async function cargarEstadoEnvasado() {
            try {
                const res = await fetch('/api/estado-lineas');
                if (!res.ok) throw new Error('Error del servidor.');
                const estados = await res.json();
                const fila = (Array.isArray(estados) ? estados : []).find(e => e.area === 'envasado');
                estadoEnvasadoActual = fila && fila.estado ? fila.estado : 'PARADO';
                siguienteProductoEnvasado = fila && fila.proximo_producto ? fila.proximo_producto : '';
                pintarEstadoEnvasado();
                pintarSiguienteEnvasado();
            } catch (e) {
                console.error(e);
            }
        }

        let cambiandoEstadoEnvasado = false;
        async function cambiarEstadoEnvasado() {
            if (cambiandoEstadoEnvasado) return;
            cambiandoEstadoEnvasado = true;
            const btn = document.getElementById('btnCambiarEstadoEnvasado');
            if (btn) btn.disabled = true;
            const nuevo = estadoEnvasadoActual === 'EN MARCHA' ? 'PARADO' : 'EN MARCHA';
            try {
                const res = await fetch('/api/estado-linea', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        area: 'envasado',
                        estado: nuevo,
                        usuario: localStorage.getItem('usuario_actual') || 'envasado_user'
                    })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    estadoEnvasadoActual = data.estado;
                    pintarEstadoEnvasado();
                } else {
                    alert('❌ ' + (data.mensaje || 'Error al cambiar el estado.'));
                }
            } catch (err) {
                console.error(err);
                alert('Error de conexión con el servidor.');
            } finally {
                cambiandoEstadoEnvasado = false;
                if (btn) btn.disabled = false;
            }
        }

        let enviandoEnvasado = false;
        document.getElementById('formEnvasado').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (enviandoEnvasado) return;
            enviandoEnvasado = true;
            const btnEnviar = e.submitter || document.querySelector('#formEnvasado button[type="submit"]');
            if (btnEnviar) btnEnviar.disabled = true;

            const presentacionSeleccionada = document.getElementById('presentacion').value;
            const observacionesTexto = document.getElementById('observaciones').value;
            const grupoTapaVisible = document.getElementById('grupoTapaDinamica').style.display === 'block';

            let observacionesFinales = observacionesTexto;
            if (grupoTapaVisible) {
                const tapaSeleccionada = document.getElementById('tapa_elegida').value;
                observacionesFinales = observacionesFinales ? `${observacionesFinales} | Tapa: ${tapaSeleccionada}` : `Tapa: ${tapaSeleccionada}`;
            }

            const formData = {
                fecha_produccion: document.getElementById('fecha_produccion').value,
                presentacion: presentacionSeleccionada,
                cantidad_cajas: parseInt(document.getElementById('cantidad_cajas').value),
                toneladas: parseFloat(document.getElementById('toneladas').value),
                observaciones: observacionesFinales,
                usuario: localStorage.getItem('usuario_actual') || 'envasado_user'
            };

            try {
                const res = await fetch('/api/produccion/reporte', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formData)
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    alert('✅ Producción registrada correctamente.');
                    document.getElementById('formEnvasado').reset();
                    document.getElementById('fecha_produccion').valueAsDate = new Date();
                    document.getElementById('grupoTapaDinamica').style.display = 'none';
                    cargarProduccionActiva();
                } else {
                    alert('❌ ' + (data.mensaje || 'Error al registrar.'));
                }
            } catch (err) {
                console.error(err);
                alert('Error de conexión con el servidor.');
            } finally {
                enviandoEnvasado = false;
                if (btnEnviar) btnEnviar.disabled = false;
            }
        });

        async function eliminarReporte(id, presentacion) {
            if (!confirm(`¿Eliminar el reporte de "${presentacion}"?\n\nSe devolverán los insumos al inventario y se quitarán las cajas de producto terminado. Podrás volver a reportarlo.`)) return;
            try {
                const res = await fetch('/api/produccion/eliminar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reporte_id: id })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    alert('✅ ' + data.mensaje);
                    cargarProduccionActiva();
                } else {
                    alert('❌ ' + (data.mensaje || 'Error al eliminar el reporte.'));
                }
            } catch (err) {
                console.error(err);
                alert('Error de conexión con el servidor.');
            }
        }

        cargarProduccionActiva();
        cargarEstadoEnvasado();
        poblarSelectsEnvasado();
        registrarAutoRefresco(() => { cargarEstadoEnvasado(); cargarProduccionActiva(); }, 15000);
    