(function () {
    var TOKEN_KEY = 'token_actual';
    var origFetch = window.fetch;

    window.fetch = function () {
        var url = arguments[0];
        var opts = arguments[1] || {};
        var token = localStorage.getItem(TOKEN_KEY);

        opts.headers = opts.headers || {};
        if (token) {
            if (typeof Headers !== 'undefined' && opts.headers instanceof Headers) {
                if (!opts.headers.has('Authorization')) opts.headers.set('Authorization', 'Bearer ' + token);
            } else if (!opts.headers.Authorization) {
                opts.headers.Authorization = 'Bearer ' + token;
            }
        }

        return origFetch.call(this, url, opts).then(function (resp) {
            if (resp.status === 401 && !isLoginUrl(url)) {
                localStorage.removeItem(TOKEN_KEY);
                window.location.href = 'index.html';
            }
            return resp;
        });
    };

    function isLoginUrl(url) {
        return typeof url === 'string' && (
            url.indexOf('/api/login') !== -1 ||
            url.indexOf('index.html') !== -1
        );
    }

    window.limpiarSesion = function () {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('usuario_actual');
        localStorage.removeItem('rol_actual');
        localStorage.removeItem('rol_usuario');
        localStorage.removeItem('permisos_actual');
    };

    function leerPermisos() {
        try {
            return JSON.parse(localStorage.getItem('permisos_actual') || '{}') || {};
        } catch (e) { return {}; }
    }

    // Override explícito por usuario y módulo. Sin override (o admin) no
    // bloquea nada: cada página aplica su control por rol como siempre.
    window.puede = function (modulo, nivel) {
        if (localStorage.getItem('rol_actual') === 'admin') return true;
        var p = leerPermisos()[modulo];
        if (!p || typeof p !== 'object') return true;
        if (nivel === 'editar') return p.editar !== false;
        return p.ver !== false;
    };

    // Bloquea la entrada al módulo si el admin le quitó la vista.
    window.exigirModulo = function (modulo) {
        if (!window.puede(modulo, 'ver')) {
            alert('❌ No tienes acceso a este módulo.');
            window.location.href = 'dashboard.html';
            return false;
        }
        return true;
    };

    // Auto-refresco único: evita que setInterval y visibilitychange disparen
    // llamadas duplicadas cuando el tab vuelve a primer plano.
    window.registrarAutoRefresco = function (fn, intervaloMs) {
        var ultimo = 0;
        var ejecutar = function () {
            if (Date.now() - ultimo > 1500) {
                ultimo = Date.now();
                fn();
            }
        };
        setInterval(ejecutar, intervaloMs || 15000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') ejecutar();
        });
    };

    // Reconstruye un <select> solo si su contenido realmente cambió:
    //  - misma firma de opciones => no toca el DOM (sin parpadeos)
    //  - usuario con el foco en el select => no interfiere, se hará en el
    //    siguiente tick (mientras elige no se le cierra el desplegable)
    //  - preserva el valor seleccionado si sigue existiendo tras reconstruir
    // `construir(select)` debe dejar el select completamente armado.
    window.repoblarSelect = function (select, firma, construir) {
        if (!select) return false;
        if (select.dataset.firma === firma) return false;
        if (select === document.activeElement || select.contains(document.activeElement)) return false;
        var previo = select.value;
        construir(select);
        select.dataset.firma = firma;
        if (previo && Array.prototype.some.call(select.options, function (o) {
            return o.value === previo;
        })) {
            select.value = previo;
        }
        return true;
    };
})();