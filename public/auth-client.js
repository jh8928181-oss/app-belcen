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
})();