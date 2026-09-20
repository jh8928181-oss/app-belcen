/* ============================================================
   motion.js — Motor de animaciones compartidas
   - Marca el documento como "js-motion" (activa motion.css)
   - Reveal on scroll con IntersectionObserver
   - Contador animado de números (window.animarConteo)
   Respeta prefers-reduced-motion.
   ============================================================ */
(function () {
    'use strict';

    var docEl = document.documentElement;
    if (docEl && docEl.classList) docEl.classList.add('js-motion');

    var reduce = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function mostrar(el) {
        el.classList.add('is-visible');
    }

    function initReveal() {
        var targets = document.querySelectorAll('.reveal');
        if (!targets.length) return;

        if (reduce || !('IntersectionObserver' in window)) {
            targets.forEach(mostrar);
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    mostrar(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

        targets.forEach(function (el) { observer.observe(el); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initReveal);
    } else {
        initReveal();
    }

    /* Contador numérico animado para KPIs / métricas */
    window.animarConteo = function (el, valorFinal, opciones) {
        if (!el) return;
        var opts = opciones || {};
        var duracion = opts.duracion || 750;
        var decimales = opts.decimales !== undefined ? opts.decimales : 0;

        var objetivo = Number(valorFinal) || 0;
        if (reduce) {
            el.textContent = objetivo.toFixed(decimales);
            return;
        }

        var inicio = performance.now();
        function paso(ahora) {
            var t = Math.min(1, (ahora - inicio) / duracion);
            var eased = 1 - Math.pow(1 - t, 3);
            var valor = objetivo * eased;
            el.textContent = valor.toFixed(decimales);
            if (t < 1) requestAnimationFrame(paso);
            else el.textContent = objetivo.toFixed(decimales);
        }
        requestAnimationFrame(paso);
    };

    /* Botón de borrado animado: al hacer clic se activa .eating
       (la papelera se abre y come las letras) y se revierte a los
       2.5s para poder repetirse. No bloquea el onclick del usuario. */
    function initComer() {
        document.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.btn-comer') : null;
            if (!btn || btn.classList.contains('eating')) return;
            btn.classList.add('eating');
            setTimeout(function () {
                btn.classList.remove('eating');
            }, 2500);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initComer);
    } else {
        initComer();
    }
})();