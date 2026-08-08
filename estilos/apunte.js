// Comportamiento de los apuntes.
// Componente .ejemplo: arma una barra de pestañas a partir de los paneles
// (.ejemplo-panel con data-titulo) y alterna cuál se muestra. Cada ejemplo es
// independiente. Si este script no corre, el CSS muestra solo el primer panel.
(function () {
  "use strict";

  function mejorar(ejemplo) {
    var paneles = [].slice.call(ejemplo.querySelectorAll(":scope > .ejemplo-panel"));
    if (paneles.length < 2) return;

    var barra = document.createElement("div");
    barra.className = "ejemplo-tabs";

    var botones = paneles.map(function (panel, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ejemplo-tab" + (i === 0 ? " is-activa" : "");
      btn.textContent = panel.getAttribute("data-titulo") || ("Vista " + (i + 1));
      btn.addEventListener("click", function () { activar(i); });
      barra.appendChild(btn);
      panel.classList.toggle("is-activa", i === 0);
      return btn;
    });

    function activar(idx) {
      botones.forEach(function (b, j) {
        b.classList.toggle("is-activa", j === idx);
        paneles[j].classList.toggle("is-activa", j === idx);
      });
    }

    ejemplo.insertBefore(barra, paneles[0]);
    ejemplo.classList.add("is-mejorada");
  }

  function init() {
    var ejemplos = document.querySelectorAll(".ejemplo");
    for (var i = 0; i < ejemplos.length; i++) mejorar(ejemplos[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
