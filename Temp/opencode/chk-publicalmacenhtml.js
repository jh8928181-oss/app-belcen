        // 🔒 Control estricto de roles (Seguridad de Planta)
        const rolUsuario = localStorage.getItem('rol_actual') || localStorage.getItem('rol_usuario');
        if (!rolUsuario || (rolUsuario !== 'almacen' && rolUsuario !== 'supervisor' && rolUsuario !== 'produccion')) {
            alert('❌ Acceso no autorizado para tu rol.');
            window.location.href = 'index.html';
        }
        if (rolUsuario !== 'supervisor' && rolUsuario !== 'produccion') {
            document.getElementById('linkDashboard').style.display = 'none'; // Aislar rol operativo
        }

        let inventarioGlobal = [];
        let productoTerminadoGlobal = [];
        let itemsDespachoArray = [];
        let itemsPTModalArray = [];
        let ingresosGlobal = [];
        let historialSalidasGlobal = [];
        let despachoEditando = null;
        document.getElementById('fecha_salida').valueAsDate = new Date();

        function cerrarSesion() {
            if (confirm('¿Estás seguro de que deseas cerrar sesión?')) {
                limpiarSesion();
                window.location.href = 'index.html';
            }
        }

        function mostrarVista(nombre, btn) {
            document.querySelectorAll('.modulo').forEach(m => m.classList.remove('activo'));
            const mod = document.getElementById('modulo-' + nombre);
            if (mod) mod.classList.add('activo');
            document.querySelectorAll('.nav-btn, .tab-btn').forEach(b => {
                b.classList.toggle('activo', b.dataset.vista === nombre);
            });
            window.scrollTo(0, 0);
        }

        let pendientesMap = {};
        let ingresoAjusteActual = null;

        /* ---------- Wizard "Registrar Ingreso" (Almacén) ---------- */
        let itemsAlmacenArray = [];
        let pasoWizardAlmacen = 0;
        let enviandoWizardAlmacen = false;
        let wizardAlmActivado = false;

        function wizardAlmVal(id) {
            const el = document.getElementById(id);
            return (el && el.value != null) ? el.value : '';
        }

        function wizardAlmInit() {
            if (wizardAlmActivado) return;
            wizardAlmActivado = true;
            const form = document.getElementById('formWizardAlm');
            if (form) form.addEventListener('submit', enviarFormularioAlmacen);
            ['almNumeroGuia', 'almProveedor'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('input', () => { el.classList.remove('campo-falta'); wizardAlmActualizar(); });
            });
            wizardAlmActualizar();
        }

        function wizardAlmPasoCompletado(n) {
            if (n === 0) {
                return Boolean(
                    document.getElementById('almNumeroGuia').value.trim() &&
                    document.getElementById('almProveedor').value.trim()
                );
            }
            if (n === 1) return itemsAlmacenArray.length > 0;
            return true;
        }

        function wizardAlmMarcarFaltantes(n) {
            const ids = n === 0 ? ['almNumeroGuia', 'almProveedor'] : [];
            ids.forEach(id => {
                const el = document.getElementById(id);
                el.classList.toggle('campo-falta', !el.value.trim());
            });
        }

        function wizardAlmActualizar() {
            const chips = document.querySelectorAll('#wizardIngresoAlm .chip-paso');
            chips.forEach((chip, i) => {
                const activo = i === pasoWizardAlmacen;
                const completo = i < pasoWizardAlmacen || wizardAlmPasoCompletado(i);
                chip.classList.toggle('activo', activo);
                chip.classList.toggle('completado', !activo && completo);
                let icono = '<span class="chip-num">' + (i + 1) + '</span>';
                if (!activo && completo) {
                    icono = '<span class="chip-check"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#1e7e34" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>';
                }
                chip.innerHTML = icono + '<span>' + ['Documento', 'Carga', 'Revisar'][i] + '</span>';
            });

            const atras = document.getElementById('almBtnPasoAtras');
            const next = document.getElementById('almBtnPasoNext');
            if (atras) atras.hidden = pasoWizardAlmacen === 0;
            if (next) {
                if (pasoWizardAlmacen === 2) {
                    next.classList.add('registrar');
                    next.innerHTML = '🚀 Registrar' + (itemsAlmacenArray.length ? ' · ' + itemsAlmacenArray.length + ' ítems' : '');
                } else {
                    next.classList.remove('registrar');
                    next.innerHTML = 'Continuar' + (pasoWizardAlmacen === 1 && itemsAlmacenArray.length ? ' · ' + itemsAlmacenArray.length + ' ítems' : '');
                }
                next.disabled = !wizardAlmPasoCompletado(pasoWizardAlmacen) || enviandoWizardAlmacen;
            }
        }

        function wizardAlmIrAPaso(n) {
            if (n === pasoWizardAlmacen) return;
            const pasosIds = ['almPasoDoc', 'almPasoCarga', 'almPasoRevisar'];
            if (n > pasoWizardAlmacen) {
                for (let i = pasoWizardAlmacen; i < n; i++) {
                    if (!wizardAlmPasoCompletado(i)) {
                        alert('Completa el paso ' + ['de Documento', 'de Carga'][i] + ' para continuar.');
                        wizardAlmMarcarFaltantes(i);
                        document.getElementById(pasosIds[i]).scrollIntoView({ behavior: 'smooth', block: 'start' });
                        return;
                    }
                }
            }
            pasoWizardAlmacen = n;
            document.querySelectorAll('#wizardIngresoAlm .paso').forEach(p => p.classList.toggle('activo', p.id === pasosIds[n]));
            if (n === 2) wizardAlmRenderResumen();
            wizardAlmActualizar();
            document.getElementById(pasosIds[n]).scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function wizardAlmAtras() {
            if (pasoWizardAlmacen > 0) wizardAlmIrAPaso(pasoWizardAlmacen - 1);
        }

        function wizardAlmNext() {
            if (!wizardAlmPasoCompletado(pasoWizardAlmacen)) {
                alert('Completa los campos requeridos de este paso para continuar.');
                wizardAlmMarcarFaltantes(pasoWizardAlmacen);
                return;
            }
            if (pasoWizardAlmacen === 2) {
                enviarFormularioAlmacen(null);
            } else {
                wizardAlmIrAPaso(pasoWizardAlmacen + 1);
            }
        }

        function wizardAlmBadge(dif) {
            if (dif === 0) return '<span class="badge-diff ok">OK</span>';
            return '<span class="badge-diff warn">⚠ ' + (dif > 0 ? '+' : '') + dif + '</span>';
        }

        function wizardAlmRenderResumen() {
            const datos = [
                { label: 'N°', value: wizardAlmVal('almNumeroGuia') },
                { label: 'Tipo', value: document.getElementById('almTipoDocumento').options[document.getElementById('almTipoDocumento').selectedIndex].text },
                { label: 'Proveedor', value: wizardAlmVal('almProveedor') },
                { label: 'Conductor', value: [wizardAlmVal('almChofer'), wizardAlmVal('almDniChofer')].filter(Boolean).join(' · ') },
                { label: 'Placa', value: wizardAlmVal('almPlaca') },
                { label: 'Ruta', value: wizardAlmVal('almLugarPartida') }
            ].filter(d => d.value);
            document.getElementById('almResumenDoc').innerHTML =
                datos.map(d => '<span class="chip-dato">' + d.label + ': <b>' + d.value + '</b></span>').join('') ||
                '<span class="sin-registros">Sin datos de documento.</span>';

            const tbody = document.getElementById('almTablaResumen');
            let sumaGuia = 0;
            let sumaFis = 0;
            tbody.innerHTML = '';
            itemsAlmacenArray.forEach(item => {
                const dif = Number(item.cantidad_fisica) - Number(item.cantidad_guia);
                sumaGuia += Number(item.cantidad_guia);
                sumaFis += Number(item.cantidad_fisica);
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><b>${item.nombre}</b></td>
                    <td class="text-center">${item.cantidad_guia}</td>
                    <td class="text-center">${item.cantidad_fisica}</td>
                    <td class="text-center">${wizardAlmBadge(dif)}</td>
                `;
                tbody.appendChild(tr);
            });
            const trTot = document.createElement('tr');
            trTot.innerHTML = `
                <td><b>TOTALES</b></td>
                <td class="text-center"><b>${sumaGuia}</b></td>
                <td class="text-center"><b>${sumaFis}</b></td>
                <td class="text-center">${wizardAlmBadge(sumaFis - sumaGuia)}</td>
            `;
            tbody.appendChild(trTot);
        }

        function wizardAlmAgregarItem() {
            const nombre = document.getElementById('almProdTextual').value.trim();
            const cantidad_guia = parseFloat(document.getElementById('almProdCantGuia').value);
            const cantidad_fisica = parseFloat(document.getElementById('almProdCantFisica').value);
            if (!nombre || isNaN(cantidad_guia) || isNaN(cantidad_fisica)) {
                alert('❌ Complete la descripción y las cantidades (guía y física).');
                return;
            }
            itemsAlmacenArray.push({ nombre, cantidad_guia, cantidad_fisica });
            wizardAlmRenderTabla();
            document.getElementById('almProdTextual').value = '';
            document.getElementById('almProdCantGuia').value = '';
            document.getElementById('almProdCantFisica').value = '';
            document.getElementById('almProdTextual').focus();
        }

        function wizardAlmQuitarItem(index) {
            itemsAlmacenArray.splice(index, 1);
            wizardAlmRenderTabla();
        }

        function wizardAlmRenderTabla() {
            const tbody = document.getElementById('almTablaItems');
            if (itemsAlmacenArray.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center sin-registros">No hay productos agregados.</td></tr>';
                wizardAlmActualizar();
                return;
            }
            tbody.innerHTML = '';
            itemsAlmacenArray.forEach((item, idx) => {
                const dif = Number(item.cantidad_fisica) - Number(item.cantidad_guia);
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><b>${item.nombre}</b></td>
                    <td class="text-center">${item.cantidad_guia}</td>
                    <td class="text-center">${item.cantidad_fisica}</td>
                    <td class="text-center">${wizardAlmBadge(dif)}</td>
                    <td class="text-center"><button type="button" onclick="wizardAlmQuitarItem(${idx})" class="btn-x">X</button></td>
                `;
                tbody.appendChild(tr);
            });
            wizardAlmActualizar();
        }

        function readLeerDocEstadoAlm(input) {
            const estado = document.getElementById('almLeerDocumentoEstado');
            if (estado) estado.textContent = input.files && input.files[0] ? 'Archivo: ' + input.files[0].name : '';
        }

        function wizardAlmMapearTipo(t) {
            const s = (t || '').toLowerCase();
            if (s.includes('factura')) return 'FACTURA';
            if (s.includes('guia') || s.includes('guía') || s.includes('remisi')) return 'GUIA DE REMISION';
            return 'OTRO';
        }

        function ocultarAvisoLeerAlm() {
            document.getElementById('almAvisoLeerDoc').style.display = 'none';
        }

        function usarTextoTodoAlm() {
            const texto = (document.getElementById('almTextoExtraidoDoc').value || '').trim();
            if (!texto) { alert('No hay texto extraído.'); return; }
            const obs = document.getElementById('almObservaciones');
            obs.value = (obs.value ? obs.value + '\n' : '') + '--- TEXTO EXTRAÍDO ---\n' + texto;
            alert('📋 Texto copiado en Observaciones.');
        }

        async function leerDocumentoAlmacen() {
            const input = document.getElementById('almFotoGuia');
            if (!input.files || !input.files[0]) {
                alert('Selecciona primero la foto o el PDF de la guía (dropzone "Toca para subir").');
                return;
            }
            const btn = document.getElementById('almBtnLeerDoc');
            if (btn) { btn.disabled = true; btn.textContent = '🤖 Leyendo…'; }
            try {
                const fd = new FormData();
                fd.append('archivo_documento', input.files[0]);
                const res = await fetch('/api/documento/leer', { method: 'POST', body: fd });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    alert('❌ ' + (data.mensaje || 'No se pudo leer el documento.'));
                    return;
                }
                const c = data.campos || {};
                document.getElementById('almTipoDocumento').value = c.tipo_documento
                    ? wizardAlmMapearTipo(c.tipo_documento) : document.getElementById('almTipoDocumento').value;
                if (c.numero_guia) document.getElementById('almNumeroGuia').value = c.numero_guia;
                if (c.proveedor) document.getElementById('almProveedor').value = c.proveedor;
                if (c.chofer) document.getElementById('almChofer').value = c.chofer;
                if (c.dni_chofer) document.getElementById('almDniChofer').value = c.dni_chofer;
                if (c.placa) document.getElementById('almPlaca').value = String(c.placa).replace(/\s+Principal$/i, '');
                if (c.partida) document.getElementById('almLugarPartida').value = c.partida;

                if (data.items && data.items.length) {
                    itemsAlmacenArray = data.items.map(i => ({
                        nombre: i.nombre,
                        cantidad_guia: Number(i.cantidad_guia) || 0,
                        cantidad_fisica: Number(i.cantidad_guia) || 0
                    }));
                    wizardAlmRenderTabla();
                }

                document.getElementById('almTextoExtraidoDoc').value = data.texto || '';
                const btnCopiarAlm = document.getElementById('almBtnCopiarTexto');
                if (btnCopiarAlm) btnCopiarAlm.style.display = (!data.reconocioGuia && data.texto && data.texto.trim()) ? '' : 'none';
                const avisoTexto = document.getElementById('almAvisoLeerDocTexto');
                let msg = data.usadoGemini
                    ? '<b>🤖 Datos leídos con IA (Gemini).</b>'
                    : '<b>🧾 Datos leídos con lector local.</b>';
                if (data.advertencias && data.advertencias.length) msg += ' ' + data.advertencias.join(' ');
                msg += ' REVÍSALOS y corrige lo que falte antes de guardar.';
                if (!data.reconocioGuia) {
                    msg = '<b>⚠ Documento no reconocido como guía.</b> ' + (data.usadoGemini ? 'La IA leyó el documento pero no encontró datos de guía en él. ' : 'No se pudieron extraer datos de guía. ') + 'Completa los campos manualmente.';
                }
                avisoTexto.innerHTML = msg;
                document.getElementById('almAvisoLeerDoc').style.display = 'block';
                document.getElementById('almAvisoLeerDoc').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (err) {
                console.error(err);
                alert('Error de conexión al leer el documento: ' + err.message);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🤖 Leer y rellenar campos'; }
            }
            wizardAlmActualizar();
        }

        async function enviarFormularioAlmacen(e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (enviandoWizardAlmacen) return;
            if (pasoWizardAlmacen !== 2) {
                wizardAlmNext();
                return;
            }
            if (itemsAlmacenArray.length === 0) {
                alert('❌ Debe agregar al menos un producto o insumo a la guía.');
                wizardAlmIrAPaso(1);
                return;
            }
            enviandoWizardAlmacen = true;
            const btnEnviar = (e && e.submitter) || document.getElementById('almBtnPasoNext');
            if (btnEnviar) { btnEnviar.disabled = true; btnEnviar.textContent = 'Enviando…'; }

            const formData = new FormData();
            formData.append('tipo_documento', wizardAlmVal('almTipoDocumento'));
            formData.append('numero_guia', wizardAlmVal('almNumeroGuia'));
            formData.append('proveedor', wizardAlmVal('almProveedor'));
            formData.append('chofer', wizardAlmVal('almChofer'));
            formData.append('dni_chofer', wizardAlmVal('almDniChofer'));
            formData.append('placa', wizardAlmVal('almPlaca'));
            formData.append('lugar_partida', wizardAlmVal('almLugarPartida'));
            formData.append('observaciones', wizardAlmVal('almObservaciones'));
            const inputFoto = document.getElementById('almFotoGuia');
            if (inputFoto && inputFoto.files && inputFoto.files[0]) formData.append('foto_guia', inputFoto.files[0]);
            formData.append('usuario', localStorage.getItem('usuario_actual') || 'almacen1');
            formData.append('items_json', JSON.stringify(itemsAlmacenArray));

            try {
                const res = await fetch('/api/almacen/registrar-conforme', { method: 'POST', body: formData });
                const data = await res.json();
                if (res.ok && data.success) {
                    mostrarExitoAlmacen(data);
                    cargarPendientes();
                    cargarRegistroIngresos();
                } else {
                    alert('❌ ' + (data.mensaje || 'Error al registrar.'));
                }
            } catch (err) {
                console.error(err);
                alert('Error de conexión con el servidor.');
            } finally {
                enviandoWizardAlmacen = false;
                if (btnEnviar) { btnEnviar.disabled = false; btnEnviar.innerHTML = '🚀 Registrar'; }
                wizardAlmActualizar();
            }
        }

        function mostrarExitoAlmacen(data) {
            const resumen = document.getElementById('almExitoResumen');
            resumen.innerHTML = `
                <div><b>N° guía:</b> ${wizardAlmVal('almNumeroGuia') || 'S/N'}</div>
                <div><b>Proveedor:</b> ${wizardAlmVal('almProveedor') || '—'}</div>
                <div><b>Ítems:</b> ${itemsAlmacenArray.length}</div>
                <div><b>Hora:</b> ${new Date().toLocaleString('es-PE')}</div>
                <div>${data.mensaje || ''}</div>
            `;
            document.getElementById('almPanelExito').style.display = 'block';
            document.getElementById('almResumenDoc').style.display = 'none';
            document.querySelector('#almPasoRevisar .tabla-wrap').style.display = 'none';
            document.getElementById('almObsRevisar').style.display = 'none';
            document.getElementById('almBarraPasos').style.display = 'none';
            document.getElementById('almPasoRevisar').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function reiniciarFormularioAlmacen() {
            document.getElementById('formWizardAlm').reset();
            itemsAlmacenArray = [];
            wizardAlmRenderTabla();
            document.getElementById('almPanelExito').style.display = 'none';
            document.getElementById('almResumenDoc').style.display = '';
            document.querySelector('#almPasoRevisar .tabla-wrap').style.display = '';
            document.getElementById('almObsRevisar').style.display = '';
            document.getElementById('almBarraPasos').style.display = '';
            const aviso = document.getElementById('almAvisoLeerDoc');
            if (aviso) aviso.style.display = 'none';
            pasoWizardAlmacen = 0;
            document.querySelectorAll('#wizardIngresoAlm .paso').forEach(p => p.classList.toggle('activo', p.id === 'almPasoDoc'));
            wizardAlmActualizar();
        }

        function toggleFormRegistroIngreso() {
            const w = document.getElementById('wizardIngresoAlm');
            const btn = document.getElementById('btnRegistroIngresoAlm');
            const barra = document.getElementById('almBarraPasos');
            const abierto = w.style.display !== 'none';
            if (abierto) {
                w.style.display = 'none';
                if (btn) btn.textContent = '➕ Registrar Ingreso';
                if (barra) barra.style.display = 'none';
            } else {
                wizardAlmInit();
                reiniciarFormularioAlmacen();
                w.style.display = 'block';
                if (btn) btn.textContent = '✖ Cerrar formulario';
                if (barra) barra.style.display = '';
                w.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
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

        async function cargarPendientes() {
            try {
                const res = await fetch('/api/almacen/pendientes');
                const data = await res.json();
                const tbody = document.getElementById('tablaPendientes');
                tbody.innerHTML = data.length === 0 ? `<tr><td colspan="5" class="text-center">No hay pendientes.</td></tr>` : '';

                const contador = document.getElementById('pendientesContador');
                if (data.length > 0) {
                    contador.textContent = `🔔 ${data.length} PENDIENTE${data.length > 1 ? 'S' : ''}`;
                    contador.style.background = '#dc3545';
                } else {
                    contador.textContent = '✔ Sin pendientes';
                    contador.style.background = '#28a745';
                }

                data.forEach(item => {
                    let itemsDetalle = '';
                    let parsedItems = [];
                    try {
                        parsedItems = JSON.parse(item.items_json || '[]');
                        parsedItems.forEach(p => {
                            let alertaDiff = p.cantidad_guia !== p.cantidad_fisica ? `<span class="diff-alerta">(Guía: ${p.cantidad_guia} | Físico: ${p.cantidad_fisica})</span>` : `(${p.cantidad_fisica})`;
                            itemsDetalle += `<div>• <b>${p.nombre}</b> ${alertaDiff}</div>`;
                        });
                    } catch(e) { itemsDetalle = item.producto_textual || 'Detalle no disponible'; }
                    pendientesMap[item.id] = parsedItems;

                    tbody.innerHTML += `
                        <tr>
                            <td><b>${item.tipo_documento}:</b> ${item.numero_guia || 'S/N'}</td>
                            <td>${item.proveedor}</td>
                            <td>${itemsDetalle}</td>
                            <td class="text-center">${item.foto_url ? `<a href="${item.foto_url}" target="_blank">Ver</a>` : '-'}</td>
                            <td class="text-center">
                                <button onclick="darConformidad(${item.id})" class="btn-accion">Dar Conformidad</button>
                                <button onclick="abrirModalRevisarAjuste(${item.id})" class="btn-accion btn-regularizar" style="margin-left: 5px;">Revisar y Ajustar</button>
                            </td>
                            </tr>
                        `;
                });
                etiquetarTablas();
            } catch(e) { console.error(e); }
        }

        let guardConformidad = false;
        async function darConformidad(id) {
            if (guardConformidad) return;
            if (!confirm('¿Confirma el ingreso de estos productos? Si hay diferencias entre la guía y el físico, se registrarán como pendientes de regularización.')) return;
            guardConformidad = true;
            try {
                const res = await fetch('/api/almacen/conformidad', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ingreso_id: id, usuario_almacen: localStorage.getItem('usuario_actual') || 'almacen1' })
                });
                const data = await res.json();
                alert(data.mensaje || 'Respuesta del servidor.');
                if (res.ok && data.success) {
                    cargarPendientes();
                    cargarInventarioAlmacen();
                    cargarRegistroIngresos();
                } else {
                    await cargarPendientes();
                }
            } catch (err) {
                console.error(err);
                alert('Error al procesar conformidad.');
            } finally {
                guardConformidad = false;
            }
        }

        // ➕ Agregar Nuevo Producto al inventario
        function abrirModalNuevoProducto() {
            const datalist = document.getElementById('datalistInsumosNombres');
            datalist.innerHTML = inventarioGlobal.map(i => `<option value="${i.nombre}"></option>`).join('');
            document.getElementById('inputNuevoNombre').value = '';
            document.getElementById('inputNuevoStock').value = 0;
            document.getElementById('modalNuevoProducto').style.display = 'flex';
        }

        function cerrarModalNuevoProducto() {
            document.getElementById('modalNuevoProducto').style.display = 'none';
        }

        let guardNuevoProducto = false;
        async function guardarNuevoProducto() {
            if (guardNuevoProducto) return;
            const nombre = document.getElementById('inputNuevoNombre').value.trim();
            const categoria = document.getElementById('selectNuevaCategoria').value;
            const unidad_medida = document.getElementById('selectNuevaUnidad').value;
            const stock = document.getElementById('inputNuevoStock').value;
            if (!nombre) { alert('❌ Ingresa el nombre del producto.'); return; }
            guardNuevoProducto = true;
            try {
                const res = await fetch('/api/inventario/nuevo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nombre, categoria, unidad_medida, stock })
                });
                const data = await res.json();
                alert(data.mensaje || 'Respuesta del servidor.');
                if (res.ok && data.success) {
                    cerrarModalNuevoProducto();
                    cargarInventarioAlmacen();
                }
            } catch (err) { console.error(err); alert('Error de conexión.'); }
            finally { guardNuevoProducto = false; }
        }

        let leyendoAjusteIA = false;
        async function leerDocumentoAjuste() {
            const input = document.getElementById('archivo_ajuste_doc');
            const estado = document.getElementById('leerAjusteEstado');
            if (!input.files || !input.files[0]) { alert('Selecciona primero el PDF o foto de la guía.'); return; }
            if (leyendoAjusteIA) return;
            leyendoAjusteIA = true;
            const btn = document.getElementById('btnLeerAjuste');
            if (btn) btn.disabled = true;
            if (estado) estado.textContent = 'Leyendo…';
            try {
                const fd = new FormData();
                fd.append('archivo_documento', input.files[0]);
                const res = await fetch('/api/documento/leer', { method: 'POST', body: fd });
                const data = await res.json();
                if (!res.ok || !data.success) { alert('❌ ' + (data.mensaje || 'No se pudo leer el documento.')); return; }
                const tbody = document.getElementById('tablaAjusteManual');
                tbody.innerHTML = '';
                const items = (data.items && data.items.length) ? data.items : [];
                if (items.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#888;">No se reconocieron productos en el documento. Agrégalos manualmente.</td></tr>`;
                    alert('⚠️ ' + ((data.advertencias && data.advertencias.length) ? data.advertencias.join(' ') : 'No se reconocieron ítems en el documento.'));
                    return;
                }
                items.forEach(it => {
                    agregarFilaAjusteVals(it.nombre || '', Number(it.cantidad_guia) || 0, Number(it.cantidad_guia) || 0, '');
                });
                if (estado) estado.textContent = 'OK: ' + items.length + ' ítem(s) cargados. REVISA antes de confirmar.';
            } catch (err) { console.error(err); alert('Error al leer el documento: ' + err.message); }
            finally {
                leyendoAjusteIA = false;
                if (btn) btn.disabled = false;
            }
        }

        // 🔧 Revisar y Ajustar conformidad (manual)
        function abrirModalRevisarAjuste(id) {
            const parsed = pendientesMap[id] || [];
            ingresoAjusteActual = id;
            const datalist = document.getElementById('datalistInsumosNombres');
            datalist.innerHTML = inventarioGlobal.map(i => `<option value="${i.nombre}"></option>`).join('');
            const tbody = document.getElementById('tablaAjusteManual');
            tbody.innerHTML = '';
            if (parsed.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#888;">Este ingreso no tiene productos detallados. Agrega uno manualmente.</td></tr>`;
            } else {
                parsed.forEach(p => agregarFilaAjusteVals(p.nombre || '', p.cantidad_fisica ?? p.cantidad, p.cantidad_guia, p.categoria || ''));
            }
            document.getElementById('modalRevisarAjuste').style.display = 'flex';
        }

        function agregarFilaAjusteVals(nombre, cantidad, cantidadGuia, categoria) {
            const tbody = document.getElementById('tablaAjusteManual');
            const emptyMsg = tbody.querySelector('td[colspan="5"]');
            if (emptyMsg) tbody.innerHTML = '';
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <input type="text" class="filaAjusteNombre" list="datalistInsumosNombres" value="${nombre}" placeholder="Nombre del producto">
                </td>
                <td><input type="number" step="0.01" min="0" class="filaAjusteCantidad" value="${cantidad !== undefined && cantidad !== null ? cantidad : ''}" title="Cantidad recibida"></td>
                <td>
                    <select class="filaAjusteCategoria">
                        <option value="BOTELLAS Y GALONERAS">Envases</option>
                        <option value="CAJAS">Cajas</option>
                        <option value="TAPAS Y ACCESORIOS">Tapas</option>
                        <option value="PREFORMAS Y SERVICIOS">Preformas</option>
                        <option value="ETIQUETAS">Etiquetas</option>
                        <option value="General">General</option>
                    </select>
                </td>
                <td>
                    <select class="filaAjusteUnidad">
                        <option value="UNIDADES">UNIDADES</option>
                        <option value="MILL">MILL</option>
                        <option value="CAJAS">CAJAS</option>
                    </select>
                </td>
                <td class="text-center"><button type="button" onclick="this.closest('tr').remove()" class="btn-x">X</button></td>
            `;
            if (categoria) row.querySelector('.filaAjusteCategoria').value = categoria;
            if (cantidadGuia !== undefined && cantidadGuia !== null && cantidadGuia !== '') {
                const tdNombre = row.querySelector('td');
                const nota = document.createElement('small');
                nota.textContent = `guía: ${cantidadGuia}`;
                nota.style.cssText = 'color:#e65100; font-size:11px; display:block;';
                tdNombre.appendChild(nota);
            }
            tbody.appendChild(row);
        }

        function agregarFilaAjuste() {
            agregarFilaAjusteVals('', '', null, '');
        }

        function cerrarModalRevisarAjuste() {
            document.getElementById('modalRevisarAjuste').style.display = 'none';
            ingresoAjusteActual = null;
            const inpAdj = document.getElementById('archivo_ajuste_doc');
            if (inpAdj) inpAdj.value = '';
            const estAdj = document.getElementById('leerAjusteEstado');
            if (estAdj) estAdj.textContent = '';
        }

        let guardAjusteManual = false;
        async function guardarAjusteManual() {
            if (guardAjusteManual) return;
            if (!ingresoAjusteActual) return;
            const filas = document.querySelectorAll('#tablaAjusteManual tr');
            const items = [];
            filas.forEach(f => {
                const inputNombre = f.querySelector('.filaAjusteNombre');
                const inputCantidad = f.querySelector('.filaAjusteCantidad');
                const nota = f.querySelector('small');
                let cantidadGuia = null;
                if (nota) {
                    const m = nota.textContent.match(/guía:\s*([\d.]+)/);
                    if (m) cantidadGuia = m[1];
                }
                if (inputNombre && inputNombre.value.trim()) {
                    items.push({
                        nombre: inputNombre.value.trim(),
                        cantidad: inputCantidad ? parseFloat(inputCantidad.value) || 0 : 0,
                        cantidad_guia: cantidadGuia,
                        categoria: (f.querySelector('.filaAjusteCategoria') || {}).value || 'General',
                        unidad_medida: (f.querySelector('.filaAjusteUnidad') || {}).value || 'UNIDADES'
                    });
                }
            });
            if (items.length === 0) { alert('❌ Agrega al menos un producto con nombre válido.'); return; }
            if (!confirm(`¿Confirmar el ajuste de ${items.length} producto(s)? Se sumará el stock indicado al inventario.`)) return;
            guardAjusteManual = true;

            try {
                const res = await fetch('/api/almacen/conformidad-ajustada', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ingreso_id: ingresoAjusteActual, usuario_almacen: localStorage.getItem('usuario_actual') || 'almacen1', items })
                });
                const data = await res.json();
                alert(data.mensaje || 'Respuesta del servidor.');
                if (res.ok && data.success) {
                    cerrarModalRevisarAjuste();
                    cargarPendientes();
                    cargarInventarioAlmacen();
                    cargarRegistroIngresos();
                }
            } catch (err) { console.error(err); alert('Error de conexión.'); }
            finally { guardAjusteManual = false; }
        }

        async function cargarRegistroIngresos() {
            try {
                const res = await fetch('/api/almacen/registro-ingresos');
                ingresosGlobal = await res.json();
                renderIngresos(ingresosGlobal);
            } catch(e) { console.error(e); }
        }

        function renderIngresos(lista) {
            const tbody = document.getElementById('tablaRegistroIngresos');            tbody.innerHTML = lista.length === 0 ? `<tr><td colspan="6" class="text-center">Sin registros.</td></tr>` : '';
            lista.forEach(row => {
                const fecha = row.fecha_registro ? fechaLocalISO(row.fecha_registro) : '';
                const badge = row.estado === 'POR REGULARIZAR'
                    ? `<span class="badge-pendiente">POR REGULARIZAR</span>`
                    : `<span class="badge-cumplido">CON GUÍA CONFORME</span>`;

                tbody.innerHTML += `
                    <tr>
                        <td><b>${fecha}</b></td>
                        <td>${row.numero_guia}</td>
                        <td>${row.proveedor}</td>
                        <td><b>${row.producto_nombre}</b></td>
                        <td class="text-center celda-azul">${row.cantidad}</td>
                        <td class="text-center">${badge}${row.categoria ? `<div class="sub-text">${row.categoria} · ${row.unidad_medida || 'UNIDADES'}</div>` : ''}</td>
                            </tr>
                        `;
                    });
                    etiquetarTablas();
                }

                function filtrarIngresos(tipo) {
            if (tipo === 'TODOS') renderIngresos(ingresosGlobal);
            else renderIngresos(ingresosGlobal.filter(i => i.estado === tipo));
        }

        async function cargarProductoTerminado() {
            try {
                const res = await fetch('/api/producto-terminado');
                const data = await res.json();
                productoTerminadoGlobal = data.filter(item => item.stock_cajas > 0);
                const tbody = document.getElementById('tablaProductoTerminado');
                tbody.innerHTML = productoTerminadoGlobal.length === 0 ? `<tr><td colspan="3" class="text-center">Sin stock disponible.</td></tr>` : '';
                productoTerminadoGlobal.forEach(item => {
                    tbody.innerHTML += `<tr><td><b>${item.nombre_producto}</b></td><td class="text-center celda-verde">${item.stock_cajas} CAJAS</td><td class="text-center"><button onclick="ajustarPT(${item.id}, '${item.nombre_producto}', ${item.stock_cajas})" class="btn-accion btn-ajustar">Ajustar</button></td></tr>`;
                    });

                    etiquetarTablas();
                    poblarSelectSalida();
            } catch(e) { console.error(e); }
        }

        function ajustarPT(id, nombre, stockActual) {
            const nuevoStock = prompt(`Ajustar stock de ${nombre}:`, stockActual);
            if (nuevoStock === null) return;
            fetch('/api/producto-terminado/ajustar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, nuevo_stock: parseInt(nuevoStock) })
            }).then(r => r.json()).then(d => {
                alert(d.mensaje || 'Respuesta del servidor.');
                cargarProductoTerminado();
            }).catch(err => { console.error(err); alert('Error de conexión.'); });
        }

        function abrirModalAgregarPT() {
            itemsPTModalArray = [];
            renderTablaPTModal();
            document.getElementById('modalAgregarPT').style.display = 'flex';
        }

        function cerrarModalAgregarPT() {
            document.getElementById('modalAgregarPT').style.display = 'none';
            itemsPTModalArray = [];
        }

        function agregarItemPTModal() {
            const select = document.getElementById('selectPTModal');
            const producto_tipo = select.value;
            const producto_nombre = select.options[select.selectedIndex].text;
            const cantidad = parseInt(document.getElementById('inputCantidadPTModal').value);

            if (isNaN(cantidad) || cantidad <= 0) {
                alert('❌ Ingrese una cantidad válida de cajas.');
                return;
            }

            itemsPTModalArray.push({ producto_tipo, producto_nombre, cantidad });
            renderTablaPTModal();
            document.getElementById('inputCantidadPTModal').value = '';
        }

        function quitarItemPTModal(index) {
            itemsPTModalArray.splice(index, 1);
            renderTablaPTModal();
        }

        function renderTablaPTModal() {
            const tbody = document.getElementById('tablaItemsPTModal');
            if (itemsPTModalArray.length === 0) {
                tbody.innerHTML = `<tr><td colspan="3" class="text-center sin-registros">No hay productos en la lista temporal.</td></tr>`;
                return;
            }
            tbody.innerHTML = '';
            itemsPTModalArray.forEach((item, idx) => {
                tbody.innerHTML += `<tr><td><b>${item.producto_nombre}</b></td><td class="text-center celda-verde">${item.cantidad} cjs</td><td class="text-center"><button type="button" onclick="quitarItemPTModal(${idx})" class="btn-x">X</button></td></tr>`;
            });
        }

        async function guardarLotePTManual() {
            if (itemsPTModalArray.length === 0) {
                alert('❌ Agregue al menos un producto a la lista antes de guardar.');
                return;
            }

            try {
                for (const item of itemsPTModalArray) {
                    const res = await fetch('/api/producto-terminado/agregar-manual', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            producto_tipo: item.producto_tipo,
                            cantidad: item.cantidad
                        })
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) {
                        alert('❌ ' + (data.mensaje || 'Error al registrar el stock manual.'));
                        return;
                    }
                }

                alert('✅ Stock de producto terminado actualizado correctamente.');
                cerrarModalAgregarPT();
                cargarProductoTerminado();
            } catch (err) {
                console.error(err);
                alert('❌ Error al registrar el stock manual.');
            }
        }

        async function cargarInventarioAlmacen() {
            try {
                const res = await fetch('/api/inventario');
                inventarioGlobal = await res.json();
                aplicarFiltros();
            } catch(e) { console.error(e); }
        }

        function mostrarInventarioAlmacen(data) {
            const tbody = document.getElementById('tablaInventarioAlmacen');
            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center">No se encontraron artículos.</td></tr>`;
                return;
            }
            const grupos = {};
            data.forEach(item => {
                const cat = item.categoria || 'SIN CATEGORÍA';
                (grupos[cat] = grupos[cat] || []).push(item);
            });
            tbody.innerHTML = '';
            Object.keys(grupos).forEach(cat => {
                tbody.innerHTML += `<tr class="sep-categoria"><td colspan="5">${cat}</td></tr>`;
                grupos[cat].forEach(item => {
                    const estado = item.estado || 'STOCK SUFICIENTE';
                    const esSuficiente = estado === 'STOCK SUFICIENTE';
                    tbody.innerHTML += `<tr><td><b>${item.nombre}</b></td><td>${item.categoria || 'SIN CATEGORÍA'}</td><td class="text-center celda-azul">${item.stock} ${item.unidad_medida}</td><td class="text-center"><span class="${esSuficiente ? 'badge-stock-ok' : 'badge-stock-bajo'}">${estado}</span></td><td class="text-center"><button onclick="ajustarStock(${item.id}, '${item.nombre}', ${item.stock})" class="btn-accion btn-ajustar">Ajustar</button></td></tr>`;
            });
                });
                etiquetarTablas();
            }

        function aplicarFiltros() {
            const categoria = document.getElementById('filtroCategoria').value;
            const texto = document.getElementById('inputBuscador').value.toLowerCase().trim();
            let resultado = inventarioGlobal;

            if (categoria !== 'TODOS') {
                resultado = resultado.filter(i => i.categoria && i.categoria.toUpperCase().includes(categoria));
            }
            if (texto !== '') {
                resultado = resultado.filter(i => i.nombre.toLowerCase().includes(texto));
            }
            mostrarInventarioAlmacen(resultado);
        }

        let guardAjustarStock = false;
        function ajustarStock(id, nombre, stockActual) {
            if (guardAjustarStock) return;
            const nuevoStock = prompt(`Ajustar stock de insumo ${nombre}:`, stockActual);
            if (nuevoStock === null) return;
            guardAjustarStock = true;
            fetch('/api/almacen/ajustar-stock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articulo_id: id, nuevo_stock: parseFloat(nuevoStock) })
            }).then(r => r.json()).then(d => {
                alert(d.mensaje || 'Respuesta del servidor.');
                cargarInventarioAlmacen();
            }).catch(err => { console.error(err); alert('Error de conexión.'); })
            .finally(() => { guardAjustarStock = false; });
        }

        function poblarSelectSalida() {
            const select = document.getElementById('selectProductoSalida');
            select.innerHTML = '<option value="">-- Seleccione producto o insumo --</option>';
            if (productoTerminadoGlobal.length > 0) {
                const g1 = document.createElement('optgroup');
                g1.label = "📦 PRODUCTO TERMINADO";
                productoTerminadoGlobal.forEach(pt => {
                    const opt = document.createElement('option');
                    opt.value = `PT:${pt.producto_key}`;
                    opt.textContent = `${pt.nombre_producto} (Stock: ${pt.stock_cajas} cjs)`;
                    g1.appendChild(opt);
                });
                select.appendChild(g1);
            }
            if (inventarioGlobal.length > 0) {
                const g2 = document.createElement('optgroup');
                g2.label = "🏭 INSUMOS";
                inventarioGlobal.forEach(ins => {
                    const opt = document.createElement('option');
                    opt.value = `INS:${ins.id}`;
                    opt.textContent = `${ins.nombre} (Stock: ${ins.stock})`;
                    g2.appendChild(opt);
                });
                select.appendChild(g2);
            }
        }

        async function leerPdfAutomatico(input) {
            if (!input.files || !input.files[0]) return;
            const formData = new FormData();
            formData.append('archivo_guia', input.files[0]);
            const estadoGuia = document.getElementById('leerGuiaEstado');
            if (estadoGuia) estadoGuia.textContent = 'Leyendo ' + input.files[0].name + '…';

            try {
                const res = await fetch('/api/salidas/leer-pdf', { method: 'POST', body: formData });
                const data = await res.json();
                if (estadoGuia) estadoGuia.textContent = '';

                if (!res.ok || !data.success) {
                    itemsDespachoArray = [];
                    renderTablaItems();
                    alert('⚠️ ' + (data.mensaje || 'No se pudo leer el PDF.'));
                    input.value = '';
                    return;
                }

                const d = data.datos || {};
                const esOCR = data.metodo === 'ocr';
                const esIA = !!data.usadoGemini;

                if (d.numero_guia) document.getElementById('numero_guia').value = d.numero_guia;
                if (d.ruc) document.getElementById('ruc').value = d.ruc;
                if (d.empresa) document.getElementById('empresa').value = d.empresa;
                if (d.destino) document.getElementById('destino').value = d.destino;
                if (d.punto_partida) document.getElementById('punto_partida').value = d.punto_partida;
                if (d.placa) document.getElementById('placa').value = d.placa;
                if (d.chofer_licencia) document.getElementById('chofer_licencia').value = d.chofer_licencia;

                const advertencias = d.advertencias || [];
                const cabeceraOk = !!(d.numero_guia || d.empresa || d.ruc || d.placa || d.chofer_licencia);

                if (d.items && d.items.length > 0) {
                    itemsDespachoArray = d.items.map(i => ({
                        nombre: i.nombre,
                        cantidad: i.cantidad,
                        producto_key: i.producto_key,
                        articulo_id: null,
                        cantidad_auto: i.cantidad_auto
                    }));
                    renderTablaItems();
                    let mensaje;
                    if (esIA) {
                        mensaje = '🤖 Guía leída con IA (Gemini). Cabecera, transporte e ítems cargados. REVISA las cantidades ⚠️.';
                    } else if (esOCR) {
                        mensaje = '🧾 Guía leída por OCR (era un escaneo). Cabecera e ítems cargados. REVISA las cantidades ⚠️.';
                    } else {
                        mensaje = cabeceraOk
                            ? '📄 Guía leída con éxito: cabecera, transporte e ítems cargados.'
                            : '📄 Ítems cargados (no se leyó cabecera).';
                    }
                    if (advertencias.length > 0) {
                        mensaje += '\n\nADVERTENCIA:\n- ' + advertencias.join('\n- ') + '\n\nRevisa las cantidades ⚠️ antes de registrar.';
                    }
                    alert(mensaje);
                } else {
                    let mensaje;
                    if (esIA) {
                        mensaje = '🤖 Guía leída con IA (Gemini), pero no se reconocieron ítems. Agrégalos manualmente.';
                    } else if (esOCR) {
                        mensaje = '🧾 Guía leída por OCR (escaneo) pero no se reconocieron ítems.';
                    } else {
                        mensaje = cabeceraOk
                            ? '📄 Cabecera leída, pero no se reconocieron los ítems automáticamente. Agrégalos manualmente.'
                            : '⚠️ No se pudo leer la guía: ni cabecera ni ítems. Agrégala manualmente.';
                    }
                    if (advertencias.length > 0) mensaje += '\n\n' + advertencias.join('\n');
                    alert(mensaje);
                }
            } catch(e) { console.error(e); alert('Error al leer el PDF.'); }
        }

        function agregarItemManual() {
            const select = document.getElementById('selectProductoSalida');
            const val = select.value;
            const text = select.options[select.selectedIndex].text;
            const cant = parseFloat(document.getElementById('cantidad_temp').value);

            if (!val || isNaN(cant) || cant <= 0) {
                alert('❌ Seleccione un producto e ingrese una cantidad.');
                return;
            }

            let producto_key = null;
            let articulo_id = null;
            if (val.startsWith('PT:')) producto_key = val.replace('PT:', '');
            else if (val.startsWith('INS:')) articulo_id = val.replace('INS:', '');

            itemsDespachoArray.push({ nombre: text, cantidad: cant, producto_key, articulo_id });
            renderTablaItems();
            document.getElementById('cantidad_temp').value = '';
        }

        function quitarItem(index) {
            itemsDespachoArray.splice(index, 1);
            renderTablaItems();
        }

        function cambiarCantidadItem(index, valor) {
            const cant = parseFloat(valor);
            itemsDespachoArray[index].cantidad = isNaN(cant) ? null : cant;
        }

        function renderTablaItems() {
            const tbody = document.getElementById('tablaItemsDespacho');
            tbody.innerHTML = itemsDespachoArray.length === 0 ? `<tr><td colspan="3" class="text-center sin-registros">No hay ítems en la lista.</td></tr>` : '';
            itemsDespachoArray.forEach((item, idx) => {
                const marcaRevisar = (item.cantidad === null || item.cantidad === undefined || isNaN(parseFloat(item.cantidad))) ? ' <span class="diff-alerta">⚠️ indicar cantidad</span>' : '';
                const valCant = (item.cantidad !== null && item.cantidad !== undefined && !isNaN(parseFloat(item.cantidad))) ? item.cantidad : '';
                tbody.innerHTML += `<tr><td><b>${item.nombre}</b>${marcaRevisar}</td><td class="text-center"><input type="number" min="0.01" step="any" class="input-cant-item" value="${valCant}" oninput="cambiarCantidadItem(${idx}, this.value)"></td><td class="text-center"><button type="button" onclick="quitarItem(${idx})" class="btn-x">X</button></td></tr>`;
            });
        }

        async function cargarHistorialSalidas() {
            try {
                const res = await fetch('/api/salidas/historial');
                historialSalidasGlobal = await res.json();
                renderizarSalidasAgrupadas(historialSalidasGlobal);
            } catch(e) { console.error(e); }
        }

        function fechaLocalISO(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return String(iso).substring(0, 10);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        function buscarSalidaPorFecha() {
            const fechaBuscada = document.getElementById('filtroFechaSalida').value;
            if (!fechaBuscada) {
                renderizarSalidasAgrupadas(historialSalidasGlobal);
                return;
            }
            const filtrado = historialSalidasGlobal.filter(s => s.fecha_salida && fechaLocalISO(s.fecha_salida) === fechaBuscada);
            renderizarSalidasAgrupadas(filtrado);
        }

        function renderizarSalidasAgrupadas(lista) {
            const contenedor = document.getElementById('contenedorHistorialSalidas');
            if (lista.length === 0) {
                contenedor.innerHTML = `<p class="text-center vacio-note">No se encontraron salidas registradas para la fecha seleccionada.</p>`;
                return;
            }

            const grupos = {};
            lista.forEach(row => {
                const fechaStr = row.fecha_salida ? fechaLocalISO(row.fecha_salida) : 'Sin Fecha';
                if (!grupos[fechaStr]) grupos[fechaStr] = [];
                grupos[fechaStr].push(row);
            });

            contenedor.innerHTML = '';
            Object.keys(grupos).sort().reverse().forEach(fecha => {
                const salidasDia = grupos[fecha];
                let filasHtml = '';
                
                salidasDia.forEach(row => {
                    const estadoBadge = row.estado_guia === 'REGULARIZADO'
                        ? `<span class="badge-cumplido">REGULARIZADO</span>`
                        : `<span class="badge-pendiente">PENDIENTE</span>`;

                    filasHtml += `
                        <tr>
                            <td>${fecha}</td>
                            <td>${row.tipo_registro}<br>${estadoBadge}</td>
                            <td><b>${row.numero_guia || 'S/N'}</b></td>
                            <td>${row.empresa}</td>
                            <td><b>${row.articulo_nombre}</b></td>
                            <td class="text-center celda-rojo">${row.cantidad_salida}</td>
                            <td class="text-center">${row.despacho_id ? `<button onclick="editarDespacho('${row.despacho_id}')" class="btn-accion btn-ajustar" title="Editar despacho">✏️</button>` : ''} ${row.estado_guia !== 'REGULARIZADO' ? `<button onclick="regularizarGuia(${row.id})" class="btn-accion btn-regularizar">Reg.</button>` : ''} <button onclick="borrarSalida('${row.despacho_id || ''}', ${row.id})" class="btn-comer" title="Eliminar despacho"><span class="ico-papelera"><span class="tapa"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/></svg></span><span class="base"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span></span><span class="texto-papelera"><span class="letra">D</span><span class="letra">e</span><span class="letra">l</span><span class="letra">e</span><span class="letra">t</span><span class="letra">e</span></span></button></td>
                        </tr>
                    `;
                });

                contenedor.innerHTML += `
                    <div class="grupo-fecha">
                        <div class="grupo-fecha-head">
                            📅 Fecha de Salida: ${fecha} | Despachos Realizados: ${salidasDia.length}
                        </div>
                        <div class="tabla-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>FECHA</th>
                                    <th>TIPO / ESTADO</th>
                                    <th>N° GUÍA</th>
                                    <th>EMPRESA</th>
                                    <th>PRODUCTO</th>
                                    <th class="text-center">CANTIDAD</th>
                                    <th class="text-center">ACCIÓN</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${filasHtml}
                            </tbody>
                        </table>
                        </div>
                    </div>
                `;
            });
        }

        let guardRegularizar = false;
        async function regularizarGuia(id) {
            if (guardRegularizar) return;
            const nuevaGuia = prompt("Ingrese el número de la Guía:");
            if (!nuevaGuia) return;
            guardRegularizar = true;
            try {
                const res = await fetch('/api/salidas/regularizar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ salida_id: id, nuevo_numero_guia: nuevaGuia.trim() })
                });
                const data = await res.json();
                alert(data.mensaje || 'Respuesta del servidor.');
                cargarHistorialSalidas();
            } catch (err) { console.error(err); alert('Error de conexión.'); }
            finally { guardRegularizar = false; }
        }

        function editarDespacho(despachoId) {
            const filas = historialSalidasGlobal.filter(r => r.despacho_id === despachoId);
            if (filas.length === 0) {
                alert('No se encontró el despacho. Solo es editable si se registró con ID de grupo.');
                return;
            }
            const h = filas[0];
            document.getElementById('tipo_registro').value = h.tipo_registro || 'CON GUIA';
            document.getElementById('numero_guia').value = h.numero_guia && h.numero_guia !== 'S/N' ? h.numero_guia : '';
            document.getElementById('empresa').value = h.empresa || '';
            document.getElementById('ruc').value = h.ruc || '';
            document.getElementById('destino').value = h.destino || '';
            document.getElementById('chofer_licencia').value = h.chofer_licencia && h.chofer_licencia !== 'N/A' ? h.chofer_licencia : '';
            document.getElementById('placa').value = h.placa && h.placa !== 'N/A' ? h.placa : '';
            document.getElementById('punto_partida').value = h.punto_partida && h.punto_partida !== 'Almacén Principal' ? h.punto_partida : '';
            if (h.fecha_salida) document.getElementById('fecha_salida').value = String(h.fecha_salida).substring(0, 10);
            document.getElementById('archivo_guia').value = '';
            itemsDespachoArray = filas.map(f => ({
                nombre: f.articulo_nombre || 'Producto General',
                cantidad: parseFloat(f.cantidad_salida) || 0,
                producto_key: f.producto_key || null,
                articulo_id: f.articulo_id ? parseInt(f.articulo_id) : null
            }));
            renderTablaItems();
            despachoEditando = despachoId;
            document.getElementById('btnRegistrarDespacho').textContent = '💾 GUARDAR CAMBIOS DEL DESPACHO';
            const bar = document.getElementById('modoEdicionBar');
            bar.style.display = 'block';
            bar.innerHTML = `✏️ Editando despacho <b>${h.numero_guia || 'S/N'}</b> — <a href="javascript:void(0)" onclick="cancelarEdicion()" style="color:#856404;">Cancelar edición</a>`;
            document.getElementById('formSalida').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function cancelarEdicion() {
            despachoEditando = null;
            document.getElementById('btnRegistrarDespacho').textContent = '🚀 REGISTRAR DESPACHO COMPLETO EN HISTORIAL';
            document.getElementById('modoEdicionBar').style.display = 'none';
            document.getElementById('formSalida').reset();
            document.getElementById('fecha_salida').valueAsDate = new Date();
            itemsDespachoArray = [];
            renderTablaItems();
        }

        let guardBorrarSalida = false;
        async function borrarSalida(despachoId, salidaId) {
            if (guardBorrarSalida) return;
            if (!confirm('¿Eliminar este despacho y restaurar el stock de producto terminado / insumos?')) return;
            guardBorrarSalida = true;
            try {
                const res = await fetch('/api/salidas/eliminar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ despacho_id: despachoId || null, salida_id: salidaId })
                });
                const data = await res.json();
                alert(data.mensaje || 'Respuesta del servidor.');
                if (res.ok && data.success) {
                    cargarHistorialSalidas();
                    cargarProductoTerminado();
                    cargarInventarioAlmacen();
                }
            } catch (err) {
                console.error(err);
                alert('Error al eliminar el despacho.');
            } finally {
                guardBorrarSalida = false;
            }
        }

        let enviandoSalida = false;
        document.getElementById('formSalida').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (enviandoSalida) return;
            enviandoSalida = true;
            const btnEnviar = e.submitter || document.querySelector('#formSalida button[type="submit"]');
            if (btnEnviar) btnEnviar.disabled = true;
            if (itemsDespachoArray.length === 0) {
                alert('❌ Debe incluir al menos un producto.');
                enviandoSalida = false;
                if (btnEnviar) btnEnviar.disabled = false;
                return;
            }
            const invalido = itemsDespachoArray.find(it => it.cantidad === null || it.cantidad === undefined || isNaN(parseFloat(it.cantidad)) || parseFloat(it.cantidad) <= 0);
            if (invalido) {
                alert('❌ El producto "' + (invalido.nombre || '?') + '" no tiene una cantidad válida. Escríbela en la casilla de cantidad.');
                enviandoSalida = false;
                if (btnEnviar) btnEnviar.disabled = false;
                return;
            }

            const formData = new FormData(e.target);
            formData.append('usuario', localStorage.getItem('usuario_actual') || 'almacen_user');
            formData.append('items_json', JSON.stringify(itemsDespachoArray));
            const esEdicion = despachoEditando !== null;
            if (esEdicion) formData.append('despacho_id', despachoEditando);

            try {
                const res = await fetch(esEdicion ? '/api/salidas/editar' : '/api/salidas/registrar', { method: 'POST', body: formData });
                const data = await res.json();
                if (res.ok && data.success) {
                    alert('✅ ' + data.mensaje);
                    cancelarEdicion();
                    cargarHistorialSalidas();
                    cargarProductoTerminado();
                    cargarInventarioAlmacen();
                } else {
                    alert('❌ ' + (data.mensaje || 'Error.'));
                }
            } catch(err) { console.error(err); alert('Error de conexión.'); }
            finally {
                enviandoSalida = false;
                if (btnEnviar) btnEnviar.disabled = false;
            }
        });

        cargarPendientes();
        cargarRegistroIngresos();
        cargarProductoTerminado();
        cargarInventarioAlmacen();
        cargarHistorialSalidas();

        registrarAutoRefresco(() => {
            cargarPendientes();
            cargarRegistroIngresos();
            cargarInventarioAlmacen();
        }, 15000);
    