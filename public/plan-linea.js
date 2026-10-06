/* Editor del plan de produccion por linea.
 *
 * El plan es la secuencia de productos que la linea va a producir: el de orden 1
 * es el que esta en curso y los siguientes son los que le siguen. Lo mueve el
 * operario a mano desde la pantalla de su linea, porque el orden de trabajo de la
 * planta lo decide quien esta en la linea, no el sistema.
 *
 * Este archivo es el mismo para envasado y soplado: las dos lineas arman su cola
 * igual y lo unico que cambia es el area. Antes cada linea tenia su propia forma
 * de senalar "el siguiente" (envasado con un select, soplado sin nada), y por eso
 * el dashboard no podia mostrar una secuencia real.
 *
 * Las claves se mandan al servidor y el servidor las valida contra recetas
 * vigentes. Ahi se descarta cualquier clave que no corresponda a una receta: es
 * lo que impide que la pantalla anuncie un producto que no existe.
 */
(function (global) {
  'use strict';

  var ETIQUETA_ORDEN = { 1: 'En producción' };

  function esc(texto) {
    return String(texto == null ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function PlanLinea(config) {
    this.area = config.area;
    this.opciones = config.opciones || [];
    this.contenedor = config.contenedor;
    this.alCambiar = config.alCambiar || function () {};
    this.alGuardar = config.alGuardar || function () {};
    this.cola = [];
    this.cargando = true;
  }

  PlanLinea.prototype.etiquetaDeOrden = function (orden) {
    return ETIQUETA_ORDEN[orden] || 'Luego';
  };

  PlanLinea.prototype.cargar = function () {
    var self = this;
    self.cargando = true;
    self.pintar();
    return fetch('/api/linea-plan')
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo leer la secuencia.');
        return r.json();
      })
      .then(function (plan) {
        self.cola = (plan && Array.isArray(plan[self.area])) ? plan[self.area].slice() : [];
        self.cargando = false;
        self.pintar();
        self.alCambiar(self.cola);
      })
      .catch(function (err) {
        self.cargando = false;
        self.contenedor.innerHTML =
          '<div class="plan-error">⚠️ ' + esc(err.message || 'Error al cargar la secuencia.') + '</div>';
      });
  };

  PlanLinea.prototype.pintar = function () {
    var self = this;
    if (!self.contenedor) return;

    if (self.cargando) {
      self.contenedor.innerHTML = '<div class="plan-vacio">Cargando secuencia…</div>';
      return;
    }

    var cuerpo = '';
    if (!self.cola.length) {
      cuerpo = '<div class="plan-vacio">Sin secuencia. Agrega el producto que se va a producir.</div>';
    } else {
      cuerpo = '<ol class="plan-lista">';
      self.cola.forEach(function (item, i) {
        var nombre = item.receta_huerfana
          ? '<span class="plan-huerfana">' + esc(item.producto_key) + ' — receta no vigente</span>'
          : esc(item.nombre_producto || item.producto_key);
        cuerpo += '<li class="plan-item' + (i === 0 ? ' plan-actual' : '') + '">'
          + '<span class="plan-pos">' + esc(self.etiquetaDeOrden(item.orden)) + '</span>'
          + '<span class="plan-nombre">' + nombre + '</span>'
          + '<span class="plan-acciones">'
          + '<button type="button" class="plan-btn" data-accion="subir" data-i="' + i + '"' + (i === 0 ? ' disabled title="El producto en curso va primero"' : '') + '>↑</button>'
          + '<button type="button" class="plan-btn" data-accion="bajar" data-i="' + i + '"' + (i === self.cola.length - 1 ? ' disabled' : '') + '>↓</button>'
          + '<button type="button" class="plan-btn plan-btn-quitar" data-accion="quitar" data-i="' + i + '" title="Quitar de la secuencia">✕</button>'
          + '</span>'
          + '</li>';
      });
      cuerpo += '</ol>';
    }

    var usadas = {};
    self.cola.forEach(function (i) { usadas[i.producto_key] = true; });
    var disponibles = self.opciones.filter(function (o) { return !usadas[o.v]; });
    var opciones = '<option value="">-- Agregar producto a la secuencia --</option>'
      + disponibles.map(function (o) {
        return '<option value="' + esc(o.v) + '">' + esc(o.l) + '</option>';
      }).join('');

    var guardado = self.cola.length ? '' : ' disabled';
    self.contenedor.innerHTML = cuerpo
      + '<div class="plan-agregar">'
      + '<select id="planAgregar_' + esc(self.area) + '" class="plan-select">' + opciones + '</select>'
      + '<button type="button" class="btn-senal" data-accion="agregar">+ Agregar</button>'
      + '</div>'
      + '<button type="button" class="btn-guardar-plan" data-accion="guardar"' + guardado + '>💾 Guardar secuencia</button>';

    self.contenedor.querySelectorAll('[data-accion]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.accion(btn.dataset.accion, btn.dataset.i); });
    });
    var sel = self.contenedor.querySelector('#planAgregar_' + self.area);
    if (sel) {
      sel.addEventListener('change', function () { self.accion('agregar', sel.value); });
    }
  };

  PlanLinea.prototype.accion = function (que, dato) {
    var self = this;
    if (que === 'agregar') {
      // Sin valor no se hace nada: el change dispara tambien cuando el
      // operador elige "-- Agregar --" para limpiar la seleccion.
      if (!dato) return;
      var nueva = self.opciones.filter(function (o) { return o.v === dato; })[0];
      if (nueva) self.cola.push({ producto_key: nueva.v, nombre_producto: nueva.l, orden: self.cola.length + 1 });
      self.renumerar();
      self.pintar();
      return;
    }
    if (que === 'guardar') return self.guardar();

    var i = parseInt(dato, 10);
    if (isNaN(i) || i < 0 || i >= self.cola.length) return;
    if (que === 'quitar') self.cola.splice(i, 1);
    else if (que === 'subir' && i > 0) {
      var tmp = self.cola[i - 1]; self.cola[i - 1] = self.cola[i]; self.cola[i] = tmp;
    } else if (que === 'bajar' && i < self.cola.length - 1) {
      var tmp2 = self.cola[i + 1]; self.cola[i + 1] = self.cola[i]; self.cola[i] = tmp2;
    }
    self.renumerar();
    self.pintar();
  };

  PlanLinea.prototype.renumerar = function () {
    this.cola.forEach(function (item, i) { item.orden = i + 1; });
  };

  PlanLinea.prototype.guardar = function () {
    var self = this;
    var btn = self.contenedor.querySelector('[data-accion="guardar"]');
    if (btn) btn.disabled = true;
    var usuario = '';
    try { usuario = localStorage.getItem('usuario_actual') || ''; } catch (e) { usuario = ''; }

    return fetch('/api/linea-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        area: self.area,
        productos: self.cola.map(function (i) { return i.producto_key; }),
        usuario: usuario
      })
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || !data.success) {
            var detalle = (data && Array.isArray(data.detalle) && data.detalle.length)
              ? '\n\n' + data.detalle.join('\n') : '';
            throw new Error((data && data.mensaje) || 'No se pudo guardar la secuencia.' + detalle);
          }
          return data;
        });
      })
      .then(function () {
        alert('✔ Secuencia guardada: ' + (self.cola.length || 'sin') + ' producto(s).');
        return self.cargar();
      })
      .then(function () { self.alGuardar(self.cola); })
      .catch(function (err) {
        alert('❌ ' + err.message);
        // Se recarga desde el servidor: lo que quedo en pantalla se descarta
        // para no dejar una cola que en realidad no se guardo.
        return self.cargar();
      });
  };

  global.PlanLinea = PlanLinea;
})(window);