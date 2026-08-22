// === Dialecto — motor SVG + DSL + Diagrama (bundle) ===
//  Dialecto 2 — renderer SVG
//  Modelo (árbol de elementos) + dibujo a SVG. Sin canvas salvo para medir texto.
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var FONT = "17px Georgia, 'Times New Roman', serif";
  var LINE_H = 23;   // alto de línea de texto
  var BASE = 5.5;    // corrección de baseline para centrar verticalmente
  var PAD = 9;       // separación base (equiv. al "separator" del código viejo)
  var SEQ_GAP = 6;   // separación vertical entre instrucciones de una secuencia
  var ARROW = 30;    // largo de la flecha de asignación
  var HEAD = 11;     // largo de la punta de flecha

  // ---- medición de texto (un canvas offscreen, sólo para el ancho) ----
  var _mc = document.createElement("canvas").getContext("2d");
  _mc.font = FONT;

  // Normaliza id de zona: si es todo dígitos, saca ceros a la izquierda ("02" -> "2"); si no, igual.
  function normId(id) {
    id = String(id);
    return /^[0-9]+$/.test(id) ? String(parseInt(id, 10)) : id;
  }

  // Resaltado manual, dos canales independientes y combinables (color: y,g,b,p,o,r):
  //   ¡¡texto¡¡   o  ¡¡color|texto¡¡     -> fondo (marcador)
  //   ¿¿texto¿¿   o  ¿¿color|texto¿¿     -> color de texto (tipo IDE)
  // Se pueden anidar para combinar, p. ej.  ¡¡g|¿¿b|v[i]¿¿¡¡  = fondo verde + texto azul.
  // Zonas (para el reproductor paso a paso): ≤IDcontenido≥  con ID de 2 caracteres, anidables.
  //   Ej.: ≤01≤02a≥ + ≤03b≥≥  -> zona 01="a + b", 02="a", 03="b". No cambian la apariencia.
  //   `zones` es una PILA compartida por el llamador (permite que una zona cruce líneas por ~~).
  function parseRuns(line, zones) {
    zones = zones || [];
    var runs = [], i = 0, n = line.length, hl = null, fg = null, buf = "";
    function push() { if (buf !== "") { runs.push({ t: buf, hl: hl, fg: fg, zn: zones.slice() }); buf = ""; } }
    function readColor() {                       // en la posición i, opcional "xxx|"
      var m = /^([a-z]{1,6})\|/.exec(line.slice(i));
      if (m) { i += m[0].length; return m[1]; }
      return null;
    }
    while (i < n) {
      var c = line.charAt(i);
      if (c === "¡" && line.charAt(i + 1) === "¡") {
        push(); i += 2;
        hl = (hl === null) ? (readColor() || "y") : null;   // abre / cierra fondo
      } else if (c === "¿" && line.charAt(i + 1) === "¿") {
        push(); i += 2;
        fg = (fg === null) ? (readColor() || "b") : null;   // abre / cierra color
      } else if (c === "≤") {                                // abre zona: ≤ + 2 chars de id
        var zid = line.substr(i + 1, 2);
        if (/^[0-9A-Za-z]{2}$/.test(zid)) { push(); zones.push(normId(zid)); i += 3; }
        else { buf += c; i++; }                              // ≤ suelto -> literal
      } else if (c === "≥") {                                // cierra zona (protege ≥ huérfano)
        push(); if (zones.length) zones.pop(); i++;
      } else { buf += c; i++; }
    }
    push();
    return runs;
  }
  function stripMarks(s) {
    return String(s).split("\n").map(function (line) {
      return parseRuns(line).map(function (r) { return r.t; }).join("");
    }).join("\n");
  }
  // ~~ = salto de línea manual (lo decide quien escribe)
  function prep(s) { return String(s).replace(/~~/g, "\n"); }

  function measure(str) {
    var lines = stripMarks(prep(str)).split("\n");
    var w = 0;
    for (var i = 0; i < lines.length; i++) w = Math.max(w, _mc.measureText(lines[i]).width);
    return { w: Math.ceil(w), h: lines.length * LINE_H };
  }

  // ---- helpers SVG ----
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function shape(g, tag, attrs) { attrs["class"] = "d-sh"; g.appendChild(el(tag, attrs)); }
  function line(g, x1, y1, x2, y2) { g.appendChild(el("line", { x1: x1, y1: y1, x2: x2, y2: y2, "class": "d-ln" })); }
  function poly(g, pts) { g.appendChild(el("polygon", { points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "), "class": "d-sh" })); }
  function solidPoly(g, pts) { g.appendChild(el("polygon", { points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "), "class": "d-solid" })); }

  function addText(g, cx, cy, str, cls, align) {
    var lines = prep(str).split("\n");
    var startY = cy - (lines.length - 1) * LINE_H / 2 + BASE;
    var zoneStack = [];   // pila de zonas, persiste entre l\u00EDneas (zona multil\u00EDnea por ~~)
    for (var i = 0; i < lines.length; i++) {
      var runs = parseRuns(lines[i], zoneStack);
      // espacios duros: evita que SVG colapse los espacios al borde de un tramo
      var texts = runs.map(function (r) { return r.t.replace(/ /g, "\u00A0"); });
      var widths = texts.map(function (s) { return _mc.measureText(s).width; });
      var total = widths.reduce(function (a, b) { return a + b; }, 0);
      var x0 = (align === "left") ? cx : cx - total / 2, y = startY + i * LINE_H;
      // 1) cajas de zona de esta l\u00EDnea (extensi\u00F3n horizontal por id), DETR\u00C1S del texto
      var zbox = {}, order = [], xacc = x0;
      for (var j = 0; j < runs.length; j++) {
        var zn = runs[j].zn, wj = widths[j];
        if (zn) for (var z = 0; z < zn.length; z++) {
          var id = zn[z];
          if (!zbox[id]) { zbox[id] = { min: xacc, max: xacc + wj }; order.push(id); }
          else { if (xacc < zbox[id].min) zbox[id].min = xacc; if (xacc + wj > zbox[id].max) zbox[id].max = xacc + wj; }
        }
        xacc += wj;
      }
      for (var o = 0; o < order.length; o++) {
        var zb = zbox[order[o]];
        g.appendChild(el("rect", { x: zb.min - 2, y: y - 15, width: (zb.max - zb.min) + 4, height: 20, rx: 3, "class": "d-zona-box", "data-zona": order[o] }));
      }
      // 2) fondos de resaltado manual + texto
      var x = x0;
      for (var k = 0; k < runs.length; k++) {
        var r = runs[k], w = widths[k];
        if (texts[k] === "") continue;
        if (r.hl) g.appendChild(el("rect", { x: x - 2, y: y - 15, width: w + 4, height: 20, rx: 3, "class": "d-hl d-hl-" + r.hl }));
        var t = el("text", { x: x, y: y, "text-anchor": "start" });
        var tc = (cls ? cls + " " : "") + (r.fg ? "d-fg-" + r.fg : "");
        if (tc.trim()) t.setAttribute("class", tc.trim());
        if (r.zn && r.zn.length) t.setAttribute("data-zona", r.zn.join(" "));
        t.textContent = texts[k];
        g.appendChild(t);
        x += w;
      }
    }
  }

  // memoización de size
  function sized(node, fn) {
    node.size = function () {
      if (!node._s) node._s = fn();
      return node._s;
    };
    return node;
  }

  var D = {};

  // ---- Asignación ----
  // op: undefined -> flecha (:=) ; "+=" / "-=" -> se dibuja ese texto en vez de la flecha
  D.assign = function (left, right, op) {
    var node = { type: "assign" };
    sized(node, function () {
      var l = measure(left), r = measure(right);
      var mw = op ? measure(op).w : ARROW;   // ancho del "medio" (flecha u operador)
      // padding vertical chico: la asignación no tiene caja, su padding se ve como aire entre líneas
      return { w: l.w + PAD + mw + PAD + r.w, h: Math.max(l.h, r.h) + PAD, l: l, r: r, mw: mw };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2, cy = top + s.h / 2;
      var ax = x0 + s.l.w + PAD;              // inicio del medio
      // texto izquierdo (centrado respecto de su celda)
      addText(g, x0 + s.l.w / 2, cy, left);
      if (op) {
        addText(g, ax + s.mw / 2, cy, op);   // operador +=/-= en lugar de la flecha
      } else {
        // flecha: cuerpo + punta rellena opaca
        line(g, ax + HEAD, cy, ax + ARROW, cy);
        solidPoly(g, [[ax, cy], [ax + HEAD, cy - 5], [ax + HEAD, cy + 5]]);
      }
      // texto derecho
      addText(g, ax + s.mw + PAD + s.r.w / 2, cy, right);
    };
    return node;
  };

  // ---- Comentario (texto itálico, verde apagado; recoloreable con ¡¡/¿¿) ----
  D.comment = function (text) {
    var node = { type: "comment" };
    sized(node, function () { var m = measure(text); return { w: m.w + 2 * PAD, h: m.h }; });
    node.draw = function (g, cx, top) {
      addText(g, cx, top + node.size().h / 2, text, "d-com");
    };
    return node;
  };

  // ---- Secuencia ----
  D.seq = function (items) {
    items = (items || []).map(wrap);
    var node = { type: "seq", items: items };
    sized(node, function () {
      var w = 0, h = 0;
      items.forEach(function (it, idx) {
        var s = it.size(); w = Math.max(w, s.w); h += s.h; if (idx < items.length - 1) h += SEQ_GAP;
      });
      return { w: w + 2 * PAD, h: h + 2 * PAD };
    });
    node.draw = function (g, cx, top) {
      var sw = node.size().w, y = top + PAD;
      items.forEach(function (it) {
        var is = it.size();
        // "locales" se pega al borde izquierdo del bloque; el resto va centrado
        var childCx = (it.type === "locals") ? (cx - sw / 2 + PAD + is.w / 2) : cx;
        it.draw(g, childCx, y);
        y += is.h + SEQ_GAP;
      });
    };
    return node;
  };
  function wrap(x) { return (x && x.size) ? x : D.assign(String(x), ""); }
  function asSeq(x) { return (x && x.type === "seq") ? x : D.seq(Array.isArray(x) ? x : [x]); }

  // ---- Decisión (Si) ----
  D["if"] = function (cond, left, right) {
    left = asSeq(left); right = asSeq(right);
    var emptyL = left.items.length === 0, emptyR = right.items.length === 0;
    var node = { type: "if" };
    sized(node, function () {
      var c = measure(cond), lc = left.size(), rc = right.size();
      var colL = lc.w + 2 * PAD, colR = rc.w + 2 * PAD;
      colL = Math.max(colL, c.w / 2 + PAD); colR = Math.max(colR, c.w / 2 + PAD);
      var roofH = c.h + 2 * PAD, bodyH = Math.max(lc.h, rc.h);
      if (emptyL) colL = Math.max(colL, bodyH * 0.75);   // celda vacía: que no quede muy finita
      if (emptyR) colR = Math.max(colR, bodyH * 0.75);
      return { w: colL + colR, h: roofH + bodyH, c: c, colL: colL, colR: colR, roofH: roofH, bodyH: bodyH };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2, baseY = top + s.roofH;
      // techo (triángulo) opaco
      poly(g, [[cx, top], [x0 + s.w, baseY], [x0, baseY]]);
      // cuerpo
      shape(g, "rect", { x: x0, y: baseY, width: s.w, height: s.bodyH });
      line(g, x0 + s.colL, baseY, x0 + s.colL, baseY + s.bodyH);
      // condición con rectángulo semitransparente detrás
      var ccy = top + s.roofH * 0.60;
      g.appendChild(el("rect", { x: cx - s.c.w / 2 - 5, y: ccy - LINE_H / 2 - 1, width: s.c.w + 10, height: LINE_H + 2, rx: 3, "class": "d-cbg" }));
      addText(g, cx, ccy, cond);
      // rama vacía -> diagonal de abajo-izquierda a arriba-derecha; si no, el contenido
      var lc = left.size(), rc = right.size();
      if (emptyL) line(g, x0, baseY + s.bodyH, x0 + s.colL, baseY);
      else left.draw(g, x0 + s.colL / 2, baseY + (s.bodyH - lc.h) / 2);
      if (emptyR) line(g, x0 + s.colL, baseY + s.bodyH, x0 + s.w, baseY);
      else right.draw(g, x0 + s.colL + s.colR / 2, baseY + (s.bodyH - rc.h) / 2);
    };
    return node;
  };

  // ---- Mientras ----
  D["while"] = function (cond, body) {
    body = asSeq(body);
    var node = { type: "while" };
    sized(node, function () {
      var c = measure(cond), b = body.size();
      var w = Math.max(c.w + 2 * PAD, b.w), band = c.h + 2 * PAD;
      return { w: w, h: band + b.h, band: band, b: b };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2;
      shape(g, "rect", { x: x0, y: top, width: s.w, height: s.h });
      line(g, x0, top + s.band, x0 + s.w, top + s.band);
      addText(g, cx, top + s.band / 2, cond);
      body.draw(g, cx, top + s.band);
    };
    return node;
  };

  // ---- Para (for) ----
  D["for"] = function (counter, begin, end, body) {
    body = asSeq(body);
    var node = { type: "for" };
    var mg = 6;                                          // margen del círculo respecto de arriba
    sized(node, function () {
      var cc = measure(counter), bb = measure(begin), ee = measure(end), b = body.size();
      var contentW = Math.max(cc.w, bb.w + ee.w + PAD);
      var d = Math.max(contentW, 2 * LINE_H) + 2 * PAD;   // diámetro del círculo
      d = Math.round(d * 1.12);
      var boxH = Math.max(d + 2 * mg, b.h + 2 * PAD);   // margen arriba y abajo del círculo
      var bodyW = d / 2 + PAD + b.w + PAD;                // deja lugar libre bajo el círculo
      return { w: d / 2 + bodyW, h: boxH, d: d, boxH: boxH, bodyW: bodyW, b: b };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2;
      var r = s.d / 2, ccx = x0 + r, cy = top + mg + r;   // círculo alineado ARRIBA con margen
      var boxLeft = ccx;
      // cuerpo (caja)
      shape(g, "rect", { x: boxLeft, y: top, width: s.bodyW, height: s.boxH });
      // círculo opaco encima (tapa el borde izquierdo de la caja)
      shape(g, "circle", { cx: ccx, cy: cy, r: r });
      line(g, ccx - r, cy, ccx + r, cy);       // diámetro horizontal
      line(g, ccx, cy, ccx, cy + r);           // divide mitad inferior
      addText(g, ccx, cy - r / 2 + 2, counter);
      addText(g, ccx - r / 2, cy + r / 2, begin);
      addText(g, ccx + r / 2, cy + r / 2, end);
      // contenido del cuerpo (a la derecha del círculo, alineado arriba)
      body.draw(g, boxLeft + s.d / 2 + PAD + s.b.w / 2, top);
    };
    return node;
  };

  // ---- Entrada / Salida ----
  // file (opcional) = variable con el archivo/handle; se dibuja en una banda arriba, separada por
  // una línea. Sin file, el bloque es idéntico al de antes (sin banda ni línea).
  function io(kind) {
    return function (content, file) {
      file = file || null;
      var node = { type: kind };
      sized(node, function () {
        var c = measure(content), f = file ? measure(file) : null;
        var fileH = file ? f.h + 2 * PAD : 0;
        var w = Math.max(c.w, file ? f.w : 0) + 5 * PAD;
        return { w: w, h: fileH + c.h + 2 * PAD, c: c, f: f, fileH: fileH };
      });
      node.draw = function (g, cx, top) {
        var s = node.size(), x0 = cx - s.w / 2, x1 = x0 + s.w, y1 = top + s.h, sl = 1.6 * PAD;
        // inset lateral en cada extremo (0 = lado ancho, sl = lado angosto), varía según kind
        var insetTop = (kind === "input") ? 0 : sl, insetBottom = (kind === "input") ? sl : 0;
        function insetEn(y) { return insetTop + (insetBottom - insetTop) * (y - top) / s.h; }
        poly(g, [[x0 + insetTop, top], [x1 - insetTop, top], [x1 - insetBottom, y1], [x0 + insetBottom, y1]]);
        if (file) {
          var yDiv = top + s.fileH, ins = insetEn(yDiv);
          line(g, x0 + ins, yDiv, x1 - ins, yDiv);
          addText(g, cx, top + s.fileH / 2, file);
        }
        addText(g, cx, top + s.fileH + (s.h - s.fileH) / 2, content);
      };
      return node;
    };
  }
  D.input = io("input");
  D.output = io("output");

  // ---- Invocar / encabezado (hexágono con divisor horizontal) ----
  D.invoke = function (name, args) {
    args = args == null ? "" : args;
    var node = { type: "invoke" };
    sized(node, function () {
      var n = measure(name), a = measure(args);
      var contentW = Math.max(n.w, a.w);
      var notch = 15;
      return { w: contentW + 2 * PAD + 2 * notch, h: 2 * (LINE_H + PAD) + PAD, notch: notch, rowH: LINE_H + PAD };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2, x1 = x0 + s.w, cy = top + s.h / 2, y1 = top + s.h, nt = s.notch;
      poly(g, [[x0, cy], [x0 + nt, top], [x1 - nt, top], [x1, cy], [x1 - nt, y1], [x0 + nt, y1]]);
      line(g, x0, cy, x1, cy);
      addText(g, cx, top + s.h / 4, name);
      addText(g, cx, top + 3 * s.h / 4, args);
    };
    return node;
  };

  // ---- Struct / registro (tabla n×2) ----
  D.struct = function (fields, title) {
    title = title || null;
    var node = { type: "struct" };
    sized(node, function () {
      var cols = fields.map(function (f) {
        var n = measure(f[0]), t = measure(f[1]);
        return { w: Math.max(n.w, t.w) + 2 * PAD, name: f[0], type: f[1] };
      });
      var tableW = cols.reduce(function (a, c) { return a + c.w; }, 0);
      var rowH = LINE_H + PAD, tableH = 2 * rowH;
      var tt = title ? measure(title) : null;
      var titleH = title ? tt.h + PAD : 0;          // título por fuera, arriba de la tabla
      return { w: Math.max(tableW, title ? tt.w : 0), h: titleH + tableH,
               cols: cols, rowH: rowH, tableW: tableW, tableH: tableH, titleH: titleH };
    });
    node.draw = function (g, cx, top) {
      var s = node.size();
      var ty = top + s.titleH, x0 = cx - s.tableW / 2;   // tabla centrada
      if (title) addText(g, x0, top + s.titleH / 2, title, "d-title", "left");  // título a la izquierda
      shape(g, "rect", { x: x0, y: ty, width: s.tableW, height: s.tableH });
      line(g, x0, ty + s.rowH, x0 + s.tableW, ty + s.rowH);
      var x = x0;
      s.cols.forEach(function (c, i) {
        if (i > 0) line(g, x, ty, x, ty + s.tableH);
        addText(g, x + c.w / 2, ty + s.rowH / 2, c.name);
        addText(g, x + c.w / 2, ty + s.rowH * 1.5, c.type);
        x += c.w;
      });
    };
    return node;
  };

  // ---- Marca circular (inicio I, fin F, retorno R) ----
  D.marker = function (letter) {
    var node = { type: "marker" };
    sized(node, function () {
      var m = measure(letter);
      var d = Math.round(Math.max(m.w, LINE_H) + PAD * 1.8);
      return { w: d, h: d, d: d };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), r = s.d / 2, cy = top + r;
      shape(g, "circle", { cx: cx, cy: cy, r: r });   // base opaca
      // resaltable: se enciende el círculo entero con {zona:"I"|"F"|"R"} (encima del fondo, debajo de la letra)
      g.appendChild(el("circle", { cx: cx, cy: cy, r: r, "class": "d-zona-box", "data-zona": normId(letter) }));
      addText(g, cx, cy, letter);
    };
    return node;
  };

  // ---- Retorno de función (rectángulo de lados redondos: "R valor") ----
  D.ret = function (value) {
    var node = { type: "ret" };
    var txt = "R  " + value;
    sized(node, function () {
      var m = measure(txt);
      return { w: m.w + 3 * PAD, h: m.h + PAD };
    });
    node.draw = function (g, cx, top) {
      var s = node.size();
      shape(g, "rect", { x: cx - s.w / 2, y: top, width: s.w, height: s.h, rx: s.h / 2, ry: s.h / 2 });   // base opaca
      // resaltable: se enciende el recuadro entero con {zona:"R"}
      g.appendChild(el("rect", { x: cx - s.w / 2, y: top, width: s.w, height: s.h, rx: s.h / 2, ry: s.h / 2, "class": "d-zona-box", "data-zona": "R" }));
      addText(g, cx, top + s.h / 2, txt);
    };
    return node;
  };

  // ---- Conector de fin de hoja (pentágono: rectángulo arriba + V abajo) ----
  D.connector = function (label) {
    label = label || "";
    var node = { type: "connector" };
    sized(node, function () {
      var m = measure(label);
      var w = Math.max(m.w + 2 * PAD, Math.round(1.4 * LINE_H));   // compacto, similar al retorno
      var rectH = m.h + Math.round(PAD * 0.6), vH = Math.round(w * 0.28);
      return { w: w, h: rectH + vH, rectH: rectH, vH: vH };
    });
    node.draw = function (g, cx, top) {
      var s = node.size(), x0 = cx - s.w / 2, x1 = cx + s.w / 2, my = top + s.rectH;
      poly(g, [[x0, top], [x1, top], [x1, my], [cx, my + s.vH], [x0, my]]);
      if (label) addText(g, cx, top + s.rectH / 2, label);
    };
    return node;
  };

  // ---- Variables locales (texto sin recuadro, alineado a la izquierda) ----
  D.locals = function (text) {
    var node = { type: "locals" };
    sized(node, function () { var m = measure(text); return { w: m.w + 2 * PAD, h: m.h }; });
    node.draw = function (g, cx, top) {
      var s = node.size();
      addText(g, cx - s.w / 2 + PAD, top + s.h / 2, text, null, "left");
    };
    return node;
  };

  // ---- render a un contenedor ----
  D.render = function (root, mount) {
    var M = 6, s = root.size();
    var W = s.w + 2 * M, H = s.h + 2 * M;
    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "class": "dialecto" });
    var g = el("g", {});
    svg.appendChild(g);
    root.draw(g, M + s.w / 2, M);
    if (mount) mount.appendChild(svg);
    return svg;
  };

  global.D = D;

  // ---- estilo por defecto (se inyecta una sola vez) ----
  var CSS =
    "svg.dialecto{display:block;margin:8px auto;overflow:visible;max-width:100%;height:auto;}" +
    "svg.dialecto text{font-family:Georgia,'Times New Roman',serif;font-size:17px;fill:#1a1a1a;}" +
    "svg.dialecto .d-sh{fill:#fbf9f2;stroke:#333;stroke-width:2;stroke-linejoin:round;}" +
    "svg.dialecto .d-ln{stroke:#333;stroke-width:2;}" +
    "svg.dialecto .d-solid{fill:#333;stroke:#333;stroke-width:1;stroke-linejoin:round;}" +
    "svg.dialecto .d-cbg{fill:rgba(251,249,242,.88);stroke:none;}" +
    "svg.dialecto .d-hl{stroke:none;}" +
    "svg.dialecto .d-hl-y{fill:rgba(255,214,64,.55);}svg.dialecto .d-hl-g{fill:rgba(130,210,120,.5);}" +
    "svg.dialecto .d-hl-b{fill:rgba(120,180,240,.5);}svg.dialecto .d-hl-p{fill:rgba(240,150,190,.5);}" +
    "svg.dialecto .d-hl-o{fill:rgba(245,160,90,.5);}svg.dialecto .d-hl-r{fill:rgba(230,110,100,.5);}" +
    "svg.dialecto .d-com{font-style:italic;fill:#5f8a5f;}" +
    "svg.dialecto .d-title{font-weight:bold;}" +
    "svg.dialecto .d-fg-y{fill:#b58900;}svg.dialecto .d-fg-g{fill:#2e8b57;}svg.dialecto .d-fg-b{fill:#2563c9;}" +
    "svg.dialecto .d-fg-p{fill:#b4308a;}svg.dialecto .d-fg-o{fill:#c26a1a;}svg.dialecto .d-fg-r{fill:#c0392b;}" +
    "svg.dialecto .d-zona-box{fill:rgba(120,195,240,.5);stroke:none;opacity:0;transition:opacity .25s ease;}" +
    "svg.dialecto .d-zona-box.activa{opacity:1;}" +
    ".dialecto-repro{margin:8px auto;}" +
    ".dialecto-repro .d-repro-casos{display:flex;gap:6px;max-width:100%;margin:0 0 10px;overflow-x:auto;padding-bottom:3px;justify-content:flex-start;}" +
    ".dialecto-repro .d-caso{flex:0 0 auto;font:14px Georgia,serif;background:#efe7d6;border:1px solid #cdbf9f;" +
    "border-radius:5px;padding:3px 14px;cursor:pointer;color:#5a4a2a;white-space:nowrap;}" +
    ".dialecto-repro .d-caso:hover{background:#e7dcc4;}" +
    ".dialecto-repro .d-caso.activo{background:#fbf9f2;border-color:#333;color:#1a1a1a;font-weight:bold;}" +
    ".dialecto-repro .d-repro-bar{display:flex;gap:8px;justify-content:center;align-items:center;margin:2px 0 12px;}" +
    ".dialecto-repro .d-repro-bar button{font:15px Georgia,serif;background:#fbf9f2;border:1px solid #333;" +
    "border-radius:4px;padding:2px 12px;cursor:pointer;line-height:1.2;}" +
    ".dialecto-repro .d-repro-bar button:hover{background:#f2eede;}" +
    ".dialecto-repro .d-repro-bar button:disabled{opacity:.4;cursor:default;}" +
    ".dialecto-repro .d-repro-paso{font-family:Georgia,serif;color:#555;min-width:54px;text-align:center;}" +
    ".dialecto-repro .d-consola{overflow:auto;resize:vertical;background:#1a1a1a;color:#e6e6e6;" +
    "font:13px/1.5 'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace;padding:6px 9px;border-radius:5px;" +
    "white-space:pre-wrap;word-break:break-word;margin:2px 0;}" +
    ".dialecto-repro .d-con-cursor{display:inline-block;width:7px;height:1.05em;background:#e6e6e6;" +
    "vertical-align:text-bottom;margin-left:1px;animation:d-blink 1.05s step-end infinite;}" +
    "@keyframes d-blink{0%,100%{opacity:1}50%{opacity:0}}" +
    ".dialecto-repro .d-diag-box{overflow:auto;resize:vertical;min-height:100px;border:1px solid #e2d8c0;border-radius:5px;}" +
    // recuadro Diagrama/Código: un solo borde (como .ejemplo/.ejemplo-tabs de los apuntes), las
    // pestañas integradas arriba; los hijos anidados pierden su propio borde (evita doble recuadro)
    ".dialecto-repro .d-vista-box{border:1px solid #e2d8c0;border-radius:5px;overflow:hidden;margin:8px 0;}" +
    ".dialecto-repro .d-vista-tabs{display:flex;gap:0;background:#f3ecdd;border-bottom:1px solid #e2d8c0;}" +
    ".dialecto-repro .d-vista-tabs button{font:14px Georgia,serif;background:none;border:none;" +
    "padding:6px 16px;cursor:pointer;color:#6a6a6a;border-bottom:2px solid transparent;margin-bottom:-1px;}" +
    ".dialecto-repro .d-vista-tabs button:hover{color:#242424;}" +
    ".dialecto-repro .d-vista-tabs button.activo{color:#242424;border-bottom-color:#b08a3e;font-weight:bold;}" +
    ".dialecto-repro .d-vista-box .d-diag-box{border:0;border-radius:0;margin:0;}" +
    ".dialecto-repro .d-vista-box .dialecto-code{border:0;border-radius:0;margin:0;}" +
    ".dialecto-repro .dialecto-code{font-size:12px;}" +   // código más chico solo en el Reproductor
    ".dialecto-repro .d-watch-box{overflow:auto;resize:vertical;min-height:40px;border:1px solid #e2d8c0;border-radius:5px;}" +
    ".dialecto-repro .d-watch{overflow-x:auto;font:13px/1.5 'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace;color:#2b2b2b;padding:2px 0;}" +
    ".dialecto-repro .d-watch table{border-collapse:collapse;}" +
    ".dialecto-repro .d-w-list{margin:0 auto;}" +
    ".dialecto-repro .d-w-list>tbody>tr>td,.dialecto-repro .d-w-list>tr>td{vertical-align:middle;padding:1px 6px;}" +
    ".dialecto-repro .d-w-key{color:#0b60b0;text-align:right;white-space:nowrap;}" +
    ".dialecto-repro .d-reg,.dialecto-repro .d-arr{border:1px solid #cbbfa3;background:#fffdf7;}" +
    ".dialecto-repro .d-reg td,.dialecto-repro .d-arr td{border:1px solid #cbbfa3;padding:1px 7px;}" +
    ".dialecto-repro .d-reg .d-f{font-weight:bold;color:#555;background:#f3ecdd;text-align:center;}" +
    ".dialecto-repro .d-arr .d-idx{color:#999;text-align:right;background:#f7f2e6;}" +
    ".dialecto-repro .d-has-tabla{padding:0 !important;}" +
    ".dialecto-repro .d-num{color:#b5651d;}" +
    ".dialecto-repro .d-str{color:#2f8a3f;}" +
    ".dialecto-repro .d-unk{color:#c0392b;font-style:italic;}" +
    ".dialecto-repro .d-col{color:#999;text-align:center;letter-spacing:3px;}" +
    ".dialecto-repro .d-w-chg{background:rgba(255,196,74,.7);border-radius:3px;padding:0 3px;}" +
    ".dialecto-error{color:#b0342b;font:13px/1.5 monospace;background:#fbeceb;border:1px solid #f0cfcb;" +
    "padding:6px 10px;border-radius:4px;margin:8px 0;white-space:pre-wrap;}" +
    ".dialecto-code{font:14px/1.55 'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace;background:#faf7ef;" +
    "color:#2b2b2b;border:1px solid #e4dcc6;border-radius:6px;padding:12px 14px;margin:12px 0;overflow-x:auto;" +
    "tab-size:4;-moz-tab-size:4;white-space:pre;}" +
    ".dialecto-code .c-com{color:#8a8577;font-style:italic;}" +
    ".dialecto-code .c-pre{color:#9b3fb0;}" +
    ".dialecto-code .c-str{color:#2f8a3f;}" +
    ".dialecto-code .c-num{color:#b5651d;}" +
    ".dialecto-code .c-kw{color:#0b60b0;font-weight:bold;}" +
    ".dialecto-code .c-fn{color:#7a5900;}" +
    ".dialecto-code .d-zona-box{background:transparent;transition:background-color .25s ease;border-radius:3px;}" +
    ".dialecto-code .d-zona-box.activa{background-color:rgba(120,195,240,.5);}" +
    // ---- dark mode ----
    "@media (prefers-color-scheme:dark){" +
    "svg.dialecto text{fill:#e8e8ea;}" +
    "svg.dialecto .d-sh{fill:#26262b;stroke:#b9b9c2;}" +
    "svg.dialecto .d-ln{stroke:#b9b9c2;}" +
    "svg.dialecto .d-solid{fill:#b9b9c2;stroke:#b9b9c2;}" +
    "svg.dialecto .d-cbg{fill:rgba(38,38,43,.9);}" +
    "svg.dialecto .d-zona-box{fill:rgba(52,120,205,.6);}" +   // azul profundo solo en dark
    "svg.dialecto .d-com{fill:#8fbf8f;}" +
    "svg.dialecto .d-fg-y{fill:#e0b341;}svg.dialecto .d-fg-g{fill:#7fd08a;}svg.dialecto .d-fg-b{fill:#6fb3ff;}" +
    "svg.dialecto .d-fg-p{fill:#e878c0;}svg.dialecto .d-fg-o{fill:#e0975a;}svg.dialecto .d-fg-r{fill:#ff6b5e;}" +
    ".dialecto-repro .d-repro-bar button{background:#303038;border-color:#b9b9c2;color:#e8e8ea;}" +
    ".dialecto-repro .d-repro-bar button:hover{background:#3a3a44;}" +
    ".dialecto-repro .d-caso{background:#303038;border-color:#55555f;color:#c9c9d2;}" +
    ".dialecto-repro .d-caso:hover{background:#3a3a44;}" +
    ".dialecto-repro .d-caso.activo{background:#23232a;border-color:#b9b9c2;color:#f0f0f2;}" +
    ".dialecto-repro .d-repro-paso{color:#a8a8b0;}" +
    ".dialecto-repro .d-diag-box,.dialecto-repro .d-watch-box{border-color:#44444c;}" +
    ".dialecto-repro .d-vista-box{border-color:#44444c;}" +
    ".dialecto-repro .d-vista-tabs{background:#26262b;border-bottom-color:#44444c;}" +
    ".dialecto-repro .d-vista-tabs button{color:#a8a8b0;}" +
    ".dialecto-repro .d-vista-tabs button:hover{color:#e2e2e8;}" +
    ".dialecto-repro .d-vista-tabs button.activo{color:#f0f0f2;border-bottom-color:#d6b45a;}" +
    ".dialecto-repro .d-watch{color:#dcdce2;}" +
    ".dialecto-repro .d-w-key{color:#6fb3ff;}" +
    ".dialecto-repro .d-reg,.dialecto-repro .d-arr{border-color:#4d4d57;background:#2e2e35;}" +
    ".dialecto-repro .d-reg td,.dialecto-repro .d-arr td{border-color:#4d4d57;}" +
    ".dialecto-repro .d-reg .d-f{color:#cfcfd6;background:#3a3a44;}" +
    ".dialecto-repro .d-arr .d-idx{color:#9a9aa4;background:#333340;}" +
    ".dialecto-repro .d-num{color:#e0975a;}" +
    ".dialecto-repro .d-str{color:#7fd08a;}" +
    ".dialecto-repro .d-unk{color:#ff6b5e;}" +
    ".dialecto-repro .d-col{color:#8a8a94;}" +
    ".dialecto-error{color:#ffb3ab;background:#3a2422;border-color:#5c3330;}" +
    ".dialecto-code{background:#26262b;color:#dcdce2;border-color:#44444c;}" +
    ".dialecto-code .c-com{color:#9a958a;}.dialecto-code .c-pre{color:#c98fe0;}" +
    ".dialecto-code .c-str{color:#7fd08a;}.dialecto-code .c-num{color:#e0975a;}" +
    ".dialecto-code .c-kw{color:#6fb3ff;}.dialecto-code .c-fn{color:#d6b45a;}" +
    // ámbar (no azul) en dark: c-kw ya es celeste, chocaría con el mismo esquema que usa el SVG
    ".dialecto-code .d-zona-box.activa{background-color:rgba(170,110,20,.55);}" +
    ".dialecto-repro .d-w-chg{background:rgba(170,110,20,.5);}" +   // resaltado de cambio legible en dark
    "}";
  function injectCSS() {
    if (!global.document || document.getElementById("dialecto-css")) return;
    var st = document.createElement("style");
    st.id = "dialecto-css";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  injectCSS();

  // helper: inserta un nodo/fragmento en el lugar del <script> que lo llama
  function rawSrc(strings, args) {
    var src = strings.raw ? strings.raw[0] : String(strings);
    for (var k = 1; k < args.length; k++) src += args[k] + strings.raw[k];
    return src;
  }
  function insertHere(node) {
    var host = document.currentScript;
    if (!host || !host.parentNode) return node;
    var anchor = host._dia || host;
    var last = node.nodeType === 11 ? node.lastChild : node;   // fragmento vs elemento
    host.parentNode.insertBefore(node, anchor.nextSibling);
    if (last) host._dia = last;                                // el siguiente del mismo script va después
    return node;
  }

  // ---- Diagrama`...` : parsea el DSL y dibuja EN EL LUGAR del <script> ----
  // Uso en un apunte:   <script>Diagrama`  si cond { ... }  `</script>
  global.Diagrama = function (strings) {
    var frag = document.createDocumentFragment();
    var r = D.parse(rawSrc(strings, arguments));
    try { frag.appendChild(D.render(r.node)); }
    catch (e) {
      var b = document.createElement("div"); b.className = "dialecto-error";
      b.textContent = "Error de dibujo: " + e.message; frag.appendChild(b);
    }
    if (r.errors && r.errors.length) {
      var er = document.createElement("div"); er.className = "dialecto-error";
      er.textContent = r.errors.join("\n"); frag.appendChild(er);
    }
    return insertHere(frag);
  };

  // ---- Reproductor(src, pasos) : diagrama con zonas + controles + expresiones (watches) ----
  // Uso:  <script>Reproductor(`  escribir ≤01≤02a≥ + ≤03b≥≥ `,
  //          [ {zona:2, expresiones:{"a":1}}, {zona:3, expresiones:{"b":2}}, {zona:1, expresiones:{"a + b":3}} ])</script>
  // - step.zona: escalar o arreglo de ids de zona a resaltar.
  // - step.expresiones: objeto clave/valor que se ACUMULA entre pasos (ver reglas de merge abajo).
  function normZonas(z) {
    if (z == null) return [];
    return (Array.isArray(z) ? z : [z]).map(normId);
  }

  // ---- expresiones (explorador tipo IDE) ----
  function h(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function esArr(v) { return Array.isArray(v); }
  function esObj(v) { return v != null && typeof v === "object" && !Array.isArray(v); }
  function esDesc(v) { return esObj(v) && Object.keys(v).length === 0; }   // {} = desconocido
  function esReg(v) { return esObj(v) && Object.keys(v).length > 0; }

  function wIgual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) return false;
    if (esArr(a) !== esArr(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b), i;
    if (ka.length !== kb.length) return false;
    for (i = 0; i < ka.length; i++) { if (!(ka[i] in b) || !wIgual(a[ka[i]], b[ka[i]])) return false; }
    return true;
  }

  // merge incremental: null borra (registros), null = sin cambio (arreglos), {} = desconocido
  function wMergeEstado(prev, delta) {
    var res = {}, k;
    for (k in prev) res[k] = prev[k];
    for (k in delta) {
      if (delta[k] === null) delete res[k];
      else res[k] = wMergeValor(res[k], delta[k]);
    }
    return res;
  }
  function wMergeValor(prevV, newV) {
    if (esArr(newV)) {
      var base = esArr(prevV) ? prevV : [], len = Math.max(base.length, newV.length), res = [], i;
      for (i = 0; i < len; i++) {
        if (i >= newV.length) res[i] = base[i];
        else if (newV[i] === null) res[i] = (i < base.length ? base[i] : {});   // sin cambio
        else res[i] = wMergeValor(base[i], newV[i]);
      }
      return res;
    }
    if (esDesc(newV)) return {};                                    // desconocido
    if (esReg(newV)) return wMergeEstado(esReg(prevV) ? prevV : {}, newV);   // registro: recursivo
    return newV;                                                    // escalar
  }
  function wEstadoEn(steps, i) {
    var st = {};
    for (var k = 0; k < i; k++) { var e = steps[k] && steps[k].expresiones; if (e) st = wMergeEstado(st, e); }
    return st;
  }

  // salida de consola acumulada hasta el paso i: se agrega; salida:null borra todo
  function consolaEn(steps, i) {
    var out = "";
    for (var k = 0; k < i; k++) {
      var s = steps[k];
      if (s && ("salida" in s)) { if (s.salida === null) out = ""; else out += String(s.salida); }
    }
    return out;
  }

  function wLeaf(text, cls, chg) { var s = h("span", cls + (chg ? " d-w-chg" : "")); s.textContent = text; return s; }
  function wCelda(val, prev) {                 // <td> con el valor (tabla anidada pega a los bordes)
    var c = h("td"), child = wRenderValor(val, prev);
    c.appendChild(child);
    if (child.tagName === "TABLE") c.className = "d-has-tabla";
    return c;
  }
  function wRenderValor(val, prev) {
    if (esArr(val)) return wRenderArr(val, esArr(prev) ? prev : []);
    if (esDesc(val)) return wLeaf("desconocido", "d-unk", !wIgual(val, prev));
    if (esReg(val)) return wRenderReg(val, esReg(prev) ? prev : {});
    return wLeaf(String(val), (typeof val === "number") ? "d-num" : "d-str", !wIgual(val, prev));
  }
  function wRenderReg(rec, prev) {
    var t = h("table", "d-reg"), trH = h("tr"), trV = h("tr");
    Object.keys(rec).forEach(function (k) {
      var f = h("td", "d-f"); f.textContent = k; trH.appendChild(f);
      trV.appendChild(wCelda(rec[k], prev[k]));
    });
    t.appendChild(trH); t.appendChild(trV); return t;
  }
  function wRenderArr(arr, prev) {
    var t = h("table", "d-arr"), i = 0;
    while (i < arr.length) {
      if (esDesc(arr[i])) {                    // colapsar corridas de desconocidos en "..."
        while (i < arr.length && esDesc(arr[i])) i++;
        var r = h("tr"), c = h("td", "d-col"); c.colSpan = 2; c.textContent = "..."; r.appendChild(c); t.appendChild(r);
      } else {
        var rr = h("tr"), ci = h("td", "d-idx"); ci.textContent = i; rr.appendChild(ci);
        rr.appendChild(wCelda(arr[i], prev[i]));
        t.appendChild(rr); i++;
      }
    }
    return t;
  }
  function wPanel(estado, prev) {              // lista superior (nombre | valor); null si vacío
    var keys = Object.keys(estado);
    if (!keys.length) return null;
    var t = h("table", "d-w-list");
    keys.forEach(function (k) {
      var r = h("tr"), kc = h("td", "d-w-key"); kc.textContent = k; r.appendChild(kc);
      r.appendChild(wCelda(estado[k], prev[k]));
      t.appendChild(r);
    });
    return t;
  }

  // scroll suave si el navegador lo soporta (mismo feature-detect que "scroll-behavior" en CSS),
  // instantáneo si no.
  var SCROLL_SUAVE = ("scrollBehavior" in document.documentElement.style);

  function makeRepro(svg, casos, watchEl, consolaEl, codeEl) {
    var roots = codeEl ? [svg, codeEl] : [svg];
    var boxes = [].concat.apply([], roots.map(function (r) { return [].slice.call(r.querySelectorAll(".d-zona-box")); }));
    var pos = casos.map(function (c) { return c.pasos.length ? 1 : 0; });   // última posición por caso (memoria)
    var ctrl = { caso: 0, timer: null };
    function steps() { return casos[ctrl.caso].pasos; }
    function minI() { return steps().length ? 1 : 0; }   // el 1er paso ES el inicio (sin estado vacío previo)
    ctrl.i = pos[0];
    function limpiar() { for (var k = 0; k < boxes.length; k++) boxes[k].classList.remove("activa"); }
    function aplicarZonas(step) {
      // filtra sobre `boxes` (ya cacheado, cubre svg + código) en vez de re-consultar el DOM:
      // así un mismo id resalta simultáneamente diagrama y código.
      var ids = normZonas(step && step.zona);
      for (var k = 0; k < boxes.length; k++) {
        var bz = (boxes[k].getAttribute("data-zona") || "").split(/\s+/);
        for (var a = 0; a < ids.length; a++) {
          if (bz.indexOf(ids[a]) !== -1) { boxes[k].classList.add("activa"); break; }
        }
      }
    }
    function centrar(el) {
      var cont = el.closest(".d-diag-box");   // sirve para diagBox y codeBox (codeBox lleva esa clase también)
      if (!cont) return;
      var er = el.getBoundingClientRect(), cr = cont.getBoundingClientRect();
      cont.scrollTo({
        top: cont.scrollTop + (er.top + er.bottom) / 2 - (cr.top + cr.bottom) / 2,
        left: cont.scrollLeft + (er.left + er.right) / 2 - (cr.left + cr.right) / 2,
        behavior: SCROLL_SUAVE ? "smooth" : "auto"
      });
    }
    function asegurarVisible() {
      roots.forEach(function (root) {
        for (var k = 0; k < boxes.length; k++) {
          if (boxes[k].classList.contains("activa") && root.contains(boxes[k])) {
            centrar(boxes[k]);   // siempre recentra (evita el salto grande de golpe al llegar al borde)
            break;   // alcanza con el primer match de esta raíz; evita "pelear" scrolls si hay varias zonas
          }
        }
      });
    }
    function pintarExpr() {
      if (!watchEl) return;
      var S = steps(), mi = minI();
      watchEl.innerHTML = "";
      var prevI = (ctrl.i <= mi) ? ctrl.i : ctrl.i - 1;   // el inicio no resalta cambios (se compara consigo mismo)
      var t = wPanel(wEstadoEn(S, ctrl.i), wEstadoEn(S, prevI));
      if (t) watchEl.appendChild(t);
    }
    function pintarConsola() {
      if (!consolaEl) return;
      var out = consolaEl.querySelector(".d-con-out");
      if (out) out.textContent = consolaEn(steps(), ctrl.i);
      consolaEl.scrollTop = consolaEl.scrollHeight;   // auto-scroll al final
    }
    ctrl.total = function () { return steps().length; };
    ctrl.minI = function () { return minI(); };
    ctrl.irA = function (n) {
      var S = steps(), mi = minI();
      ctrl.i = Math.max(mi, Math.min(S.length, n));
      limpiar();
      if (ctrl.i > mi) { aplicarZonas(S[ctrl.i - 1]); asegurarVisible(); }   // el inicio (mi) no resalta zonas
      pintarExpr();
      pintarConsola();
      if (ctrl.actualizar) ctrl.actualizar();
    };
    ctrl.inicio = function () { ctrl.pausa(); ctrl.irA(minI()); };
    ctrl.anterior = function () { ctrl.pausa(); ctrl.irA(ctrl.i - 1); };
    ctrl.siguiente = function () { ctrl.irA(ctrl.i + 1); };
    ctrl.pausa = function () {
      if (ctrl.timer) { clearInterval(ctrl.timer); ctrl.timer = null; }
      if (ctrl.onplay) ctrl.onplay(false);
    };
    ctrl.play = function () {
      if (ctrl.timer) { ctrl.pausa(); return; }
      if (ctrl.i >= steps().length) ctrl.irA(minI());   // reiniciar si estaba al final
      if (ctrl.onplay) ctrl.onplay(true);
      ctrl.timer = setInterval(function () {
        if (ctrl.i >= steps().length) { ctrl.pausa(); return; }
        ctrl.siguiente();
        if (ctrl.i >= steps().length) ctrl.pausa();
      }, 1000);
    };
    ctrl.irACaso = function (c) {
      if (c === ctrl.caso || c < 0 || c >= casos.length) return;
      ctrl.pausa();
      pos[ctrl.caso] = ctrl.i;   // recordar dónde quedé en el caso actual
      ctrl.caso = c;
      ctrl.irA(pos[c]);          // continuar donde había dejado el caso destino
      if (ctrl.onCaso) ctrl.onCaso(c);
    };
    return ctrl;
  }

  global.Reproductor = function (primero, steps, config) {
    config = config || {};
    // 1er parámetro: string (solo diagrama, como antes) u objeto {diagrama, código|codigo}
    var esObjetoFuente = primero && typeof primero === "object" && !Array.isArray(primero);
    var diagramaSrc = esObjetoFuente ? primero.diagrama : primero;
    var tieneCodigo = esObjetoFuente && (primero["código"] != null || primero.codigo != null);
    var codigoSrc = tieneCodigo ? (primero["código"] != null ? primero["código"] : primero.codigo) : null;

    // 2º parámetro: array (una sola grabación) u objeto {nombre: pasos, ...} (varios "casos")
    var conCasos = steps && !Array.isArray(steps) && typeof steps === "object";
    var casos;
    if (Array.isArray(steps)) casos = [{ nombre: null, pasos: steps }];
    else if (conCasos) casos = Object.keys(steps).map(function (k) {
      return { nombre: k, pasos: Array.isArray(steps[k]) ? steps[k] : [] };
    });
    else casos = [{ nombre: null, pasos: [] }];
    if (!casos.length) { casos = [{ nombre: null, pasos: [] }]; conCasos = false; }

    var wrap = document.createElement("div");
    wrap.className = "dialecto-repro";

    // selector de casos (arriba de todo), scrolleable en horizontal si hay muchos
    var selEl = null, casoBtns = [];
    if (conCasos) { selEl = h("div", "d-repro-casos"); wrap.appendChild(selEl); }

    // recuadro Diagrama/Código: con código, un solo borde (como .ejemplo) con las pestañas
    // integradas arriba; sin código, el diagrama queda suelto tal como antes (sin regresión)
    var vistaEl = null, diagTabBtn = null, codeTabBtn = null, vistaBox = wrap;
    if (tieneCodigo) {
      vistaBox = h("div", "d-vista-box"); wrap.appendChild(vistaBox);
      vistaEl = h("div", "d-vista-tabs");
      diagTabBtn = document.createElement("button");
      diagTabBtn.type = "button"; diagTabBtn.className = "activo"; diagTabBtn.textContent = "Diagrama";
      codeTabBtn = document.createElement("button");
      codeTabBtn.type = "button"; codeTabBtn.textContent = "Código";
      vistaEl.appendChild(diagTabBtn); vistaEl.appendChild(codeTabBtn);
      vistaBox.appendChild(vistaEl);
    }

    var r = D.parse(String(diagramaSrc));
    var svg = null, diagBox = null;
    try {
      svg = D.render(r.node);
      diagBox = h("div", "d-diag-box"); diagBox.appendChild(svg);   // caja con scroll + resize vertical
      vistaBox.appendChild(diagBox);
    }
    catch (e) {
      var eb = document.createElement("div"); eb.className = "dialecto-error";
      eb.textContent = "Error de dibujo: " + e.message; wrap.appendChild(eb);
    }
    if (r.errors && r.errors.length) {
      var er = document.createElement("div"); er.className = "dialecto-error";
      er.textContent = r.errors.join("\n"); wrap.appendChild(er);
    }

    // panel de código (opcional): mismas zonas que el diagrama, oculto hasta elegir la pestaña
    var codeBox = null, codePre = null;
    if (svg && tieneCodigo) {
      codePre = document.createElement("pre"); codePre.className = "dialecto-code";
      codePre.innerHTML = highlightCZonas(dedent(String(codigoSrc)));
      codeBox = h("div", "d-code-box d-diag-box"); codeBox.appendChild(codePre);
      codeBox.style.display = "none";   // arranca oculto: la vista por defecto es "Diagrama"
      vistaBox.appendChild(codeBox);
    }

    var ctrl = null, watchEl = null;
    if (svg) {
      var bar = document.createElement("div"); bar.className = "d-repro-bar";
      function boton(txt, title) {
        var x = document.createElement("button");
        x.type = "button"; x.textContent = txt; x.title = title; return x;
      }
      var bIni = boton("⏮", "Inicio"), bPrev = boton("<", "Anterior"),
          bPlay = boton("▶", "Reproducir"), bNext = boton(">", "Siguiente");
      var paso = document.createElement("span"); paso.className = "d-repro-paso";
      bar.appendChild(bIni); bar.appendChild(bPrev); bar.appendChild(bPlay);
      bar.appendChild(bNext); bar.appendChild(paso);
      wrap.appendChild(bar);
      // consola (opcional): se dibuja solo si config.consola está presente
      var consolaEl = null;
      if (config.consola) {
        var lineas = config.consola.lineas || 3;
        consolaEl = h("div", "d-consola");
        consolaEl.appendChild(h("span", "d-con-out"));
        consolaEl.appendChild(h("span", "d-con-cursor"));
        consolaEl.style.height = Math.round(lineas * 19.5 + 12) + "px";   // alto predeterminado por líneas
        wrap.appendChild(consolaEl);
      }
      watchEl = h("div", "d-watch");
      var watchBox = h("div", "d-watch-box"); watchBox.appendChild(watchEl); wrap.appendChild(watchBox);

      ctrl = makeRepro(svg, casos, watchEl, consolaEl, codePre);
      ctrl.onplay = function (on) {
        bPlay.textContent = on ? "⏸" : "▶";
        bPlay.title = on ? "Pausar" : "Reproducir";
        wrap.classList.toggle("d-playing", on);   // el cursor titila solo mientras reproduce
      };
      ctrl.actualizar = function () {
        var N = ctrl.total(), mi = ctrl.minI();
        paso.textContent = ctrl.i + " / " + N;
        bIni.disabled = bPrev.disabled = (ctrl.i <= mi);
        bNext.disabled = (ctrl.i >= N);
      };
      bIni.onclick = ctrl.inicio; bPrev.onclick = ctrl.anterior;
      bNext.onclick = ctrl.siguiente; bPlay.onclick = ctrl.play;

      // botones de casos (títulos = claves); recuerdan el paso de cada grabación
      if (selEl) {
        casos.forEach(function (c, idx) {
          var cb = document.createElement("button");
          cb.type = "button"; cb.className = "d-caso";
          cb.textContent = c.nombre; cb.title = c.nombre;
          cb.onclick = function () { ctrl.irACaso(idx); };
          selEl.appendChild(cb); casoBtns.push(cb);
        });
        ctrl.onCaso = function (c) {
          for (var k = 0; k < casoBtns.length; k++) casoBtns[k].classList.toggle("activo", k === c);
        };
      }
    }
    insertHere(wrap);
    if (ctrl) {
      // alto disponible en pantalla para el box activo, descontando todo lo que lo rodea
      function avail() {
        var vistaH = vistaEl ? vistaEl.offsetHeight : 0;
        var selH = selEl ? selEl.offsetHeight : 0;
        var barH = bar ? bar.offsetHeight : 0;
        var exprH = watchBox ? watchBox.offsetHeight : 0;
        var consH = consolaEl ? consolaEl.offsetHeight : 0;
        return (global.innerHeight || 800) - vistaH - selH - barH - exprH - consH - 48;
      }
      // alto estable: reservar el alto máximo del panel de expresiones sobre TODAS las grabaciones
      var maxH = 0;
      casos.forEach(function (c) {
        for (var i = 0; i <= c.pasos.length; i++) {
          watchEl.innerHTML = "";
          var t = wPanel(wEstadoEn(c.pasos, i), {});
          if (t) watchEl.appendChild(t);
          if (watchEl.offsetHeight > maxH) maxH = watchEl.offsetHeight;
        }
      });
      watchEl.style.minHeight = maxH + "px";
      // alto inicial del diagrama: completo, o el máximo disponible en pantalla
      // (para poder verlo junto con controles/consola/expresiones)
      if (diagBox && svg) {
        var setDiagH = function (contentH) {   // contentH incluye márgenes del svg
          var a = avail();
          var hInit = (contentH <= a) ? contentH : Math.max(160, a);
          diagBox.style.height = Math.round(hInit) + "px";
          // el código comparte el mismo alto que el diagrama (medido solo del diagrama), para que
          // cambiar de pestaña no mueva nada de lo que está debajo; si el código es más alto, scrollea
          if (codeBox) codeBox.style.height = diagBox.style.height;
        };
        var attrH = parseFloat(svg.getAttribute("height")) || 0;
        if (attrH) setDiagH(attrH + 20);   // sincrónico: alto natural aprox (el layout aún no resolvió height:auto)
        // resize manual (arrastrar el borde de cualquiera de las dos cajas): espejar el alto en la
        // otra, para que no queden desincronizadas al volver a esa pestaña. La caja oculta
        // (display:none) no tiene layout propio, así que solo la visible dispara el observer.
        if (codeBox && global.ResizeObserver) {
          var syncingH = false;
          var espejar = function (origen, destino) {
            return function () {
              if (syncingH) return;
              // el cambio de pestaña también dispara el observer (la caja que se oculta "resizea" a
              // 0): ignorarlo, si no pisa el alto nuevo con el valor viejo de la caja que se esconde
              if (global.getComputedStyle(origen).display === "none") return;
              var h = origen.style.height;
              if (h && destino.style.height !== h) {
                syncingH = true;
                destino.style.height = h;
                syncingH = false;
              }
            };
          };
          new global.ResizeObserver(espejar(diagBox, codeBox)).observe(diagBox);
          new global.ResizeObserver(espejar(codeBox, diagBox)).observe(codeBox);
        }
        if (global.requestAnimationFrame) {
          global.requestAnimationFrame(function () {
            setDiagH(diagBox.scrollHeight || attrH + 20);   // refina con el alto real del contenido
          });
        }
      }
      function mostrarVista(cual) {
        diagBox.style.display = (cual === "codigo") ? "none" : "";
        if (codeBox) codeBox.style.display = (cual === "codigo") ? "" : "none";
        if (diagTabBtn) diagTabBtn.classList.toggle("activo", cual !== "codigo");
        if (codeTabBtn) codeTabBtn.classList.toggle("activo", cual === "codigo");
      }
      if (vistaEl) {
        diagTabBtn.onclick = function () { mostrarVista("diagrama"); };
        codeTabBtn.onclick = function () { mostrarVista("codigo"); };
      }
      ctrl.irA(ctrl.i);                          // arranca en la posición del caso 0
      if (ctrl.onCaso) ctrl.onCaso(ctrl.caso);   // marca el caso activo en el selector
    }
    return wrap;
  };

  // ---- Resaltado de C/C++ (HTML puro: <pre> con <span> coloreados, sin imágenes) ----
  var C_KW = "\\b(?:alignas|alignof|asm|auto|bool|break|case|catch|char|char16_t|char32_t|class|" +
    "const|constexpr|const_cast|continue|decltype|default|delete|do|double|dynamic_cast|else|enum|" +
    "explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|" +
    "noexcept|nullptr|operator|private|protected|public|register|reinterpret_cast|return|short|" +
    "signed|sizeof|static|static_cast|struct|switch|template|this|throw|true|try|typedef|typename|" +
    "union|unsigned|using|virtual|void|volatile|wchar_t|while|NULL|size_t|string|std|cout|cin|endl)\\b";
  function escHTML(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function dedent(s) {
    s = s.replace(/^\n+/, "").replace(/[ \t\n]+$/, "");
    var lines = s.split("\n"), min = Infinity;
    // medir ignorando marcadores de zona (≤XX/≥), por si alguno cae antes de la indentación real
    lines.forEach(function (l) {
      if (l.trim()) { var n = l.replace(/≤[0-9A-Za-z]{2}|≥/g, "").match(/^[ \t]*/)[0].length; if (n < min) min = n; }
    });
    if (min === Infinity) min = 0;
    return lines.map(function (l) { return l.slice(min); }).join("\n");
  }
  var C_RE = new RegExp([
    "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)",                                   // 1 comentario
    "(#[^\\n]*)",                                                               // 2 preprocesador
    "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')",                         // 3 string / char
    "(\\b(?:0[xX][0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)[fFuUlL]*\\b)",    // 4 número
    "(" + C_KW + ")",                                                          // 5 palabra clave
    "([A-Za-z_]\\w*(?=\\s*\\())"                                               // 6 función (id antes de "(")
  ].join("|"), "g");
  var C_CLS = [null, "c-com", "c-pre", "c-str", "c-num", "c-kw", "c-fn"];

  // solo datos: [{start, end, cls}] de los tramos que matchean sintaxis C. Sin HTML.
  function cSpans(text) {
    var out = [], m;
    C_RE.lastIndex = 0;
    while ((m = C_RE.exec(text))) {
      var cls = null;
      for (var g = 1; g <= 6; g++) { if (m[g] !== undefined) { cls = C_CLS[g]; break; } }
      out.push({ start: m.index, end: C_RE.lastIndex, cls: cls });
      if (m[0] === "") C_RE.lastIndex++;   // evita bucle infinito ante match vacío
    }
    return out;
  }

  // resaltado de sintaxis C "de siempre" (usado por Código/Codigo). Sin interpretar ¡¡/¿¿/≤≥.
  function highlightC(src) {
    var out = "", last = 0;
    cSpans(src).forEach(function (s) {
      out += escHTML(src.slice(last, s.start)) + '<span class="' + s.cls + '">' +
             escHTML(src.slice(s.start, s.end)) + "</span>";
      last = s.end;
    });
    return out + escHTML(src.slice(last));
  }

  // resaltado de sintaxis C + zonas ≤ID…≥ (solo para el panel de código del Reproductor).
  // Paso A: separar zonas reusando parseRuns línea por línea (≤/≥ no existen en C real, así que
  // el marcado es inequívoco). Paso B: sintaxis C vía cSpans sobre el texto ya limpio. Paso C:
  // merge por dos punteros -> un solo <span> plano por tramo mínimo, combinando ambas clases.
  function highlightCZonas(src) {
    var zoneStack = [], offset = 0, zRuns = [], texto = "";
    var lines = src.split("\n");   // NUNCA prep(): ~~ es un NOT-NOT válido en C
    for (var i = 0; i < lines.length; i++) {
      parseRuns(lines[i], zoneStack).forEach(function (r) {
        zRuns.push({ start: offset, end: offset + r.t.length, zn: r.zn });
        offset += r.t.length; texto += r.t;
      });
      if (i < lines.length - 1) {
        zRuns.push({ start: offset, end: offset + 1, zn: zoneStack.slice() });   // el salto de línea
        offset += 1; texto += "\n";
      }
    }
    var sMatches = cSpans(texto);
    var cortes = {}; zRuns.forEach(function (r) { cortes[r.start] = cortes[r.end] = 1; });
    sMatches.forEach(function (s) { cortes[s.start] = cortes[s.end] = 1; });
    var pts = Object.keys(cortes).map(Number).sort(function (a, b) { return a - b; });
    var out = "", zi = 0, si = 0;
    for (var p = 0; p < pts.length - 1; p++) {
      var s0 = pts[p], s1 = pts[p + 1];
      if (s0 >= s1) continue;
      while (zRuns[zi] && zRuns[zi].end <= s0) zi++;
      while (sMatches[si] && sMatches[si].end <= s0) si++;
      var zn = (zRuns[zi] && zRuns[zi].start <= s0) ? zRuns[zi].zn : [];
      var cls = (sMatches[si] && sMatches[si].start <= s0) ? sMatches[si].cls : null;
      var chunk = escHTML(texto.slice(s0, s1));
      var classes = (cls ? [cls] : []).concat(zn.length ? ["d-zona-box"] : []);
      if (classes.length) {
        out += '<span class="' + classes.join(" ") + '"' + (zn.length ? ' data-zona="' + zn.join(" ") + '"' : "") + '>' + chunk + "</span>";
      } else out += chunk;
    }
    return out;
  }

  // ---- Código`...` : recuadro de código C/C++ resaltado, EN EL LUGAR del <script> ----
  // Uso en un apunte:   <script>Código`  int main() { return 0; }  `</script>
  global["Código"] = global.Codigo = function (strings) {
    var pre = document.createElement("pre");
    pre.className = "dialecto-code";
    pre.innerHTML = highlightC(dedent(rawSrc(strings, arguments)));
    return insertHere(pre);
  };
})(window);

//  Dialecto — mini-lenguaje de texto -> modelo D
//  Bloques con llaves { }.  Asignación con :=
//
//    leer x                         -> entrada
//    escribir e                     -> salida
//    x := e                         -> asignación
//    invocar f(args)                -> invocación de procedimiento
//    si COND { ... } sino { ... }   -> decisión (sino opcional)
//    mientras COND { ... }          -> mientras
//    para i de A a B { ... }        -> para
//    procedimiento nombre(params) { ... } -> encabezado + cuerpo + retorno (R) implícito
//    funcion nombre(params) { ... } -> idem
//    registro { campo: tipo, ... }  -> struct (tabla n×2)
//
//  El resaltado (==...== y `...`) viaja como parte del texto, sin tocar.
(function (global) {
  "use strict";
  var D = global.D;

  // --- tokenizador: separa llaves y terminadores de sentencia ---
  function tokenize(src) {
    var toks = [], buf = "";
    function flush() { var s = buf.trim(); if (s) toks.push({ k: "t", s: s }); buf = ""; }
    for (var p = 0; p < src.length; p++) {
      var c = src[p];
      if (c === "{" || c === "}" || c === ";") { flush(); toks.push({ k: c }); }
      else if (c === "\n") { flush(); toks.push({ k: "nl" }); }
      else buf += c;
    }
    flush();
    return toks;
  }

  function skipSep(toks, i) { while (i.v < toks.length && (toks[i.v].k === "nl" || toks[i.v].k === ";")) i.v++; }
  function expectBrace(toks, i, err) {
    skipSep(toks, i);
    if (toks[i.v] && toks[i.v].k === "{") { i.v++; return true; }
    err.push("falta « { »"); return false;
  }

  function parseBlock(toks, i, inner, err) {
    var nodes = [];
    while (i.v < toks.length) {
      var t = toks[i.v];
      if (t.k === "nl" || t.k === ";") { i.v++; continue; }
      if (t.k === "}") { if (inner) i.v++; return nodes; }
      if (t.k === "{") { err.push("« { » inesperada"); i.v++; continue; }
      var n = parseStatement(toks, i, err);
      if (n) nodes.push(n);
    }
    if (inner) err.push("falta « } »");
    return nodes;
  }

  function callParts(s) {
    var m = s.match(/^([^(]*)\(([\s\S]*)\)\s*$/);
    if (m) return { name: m[1].trim(), args: m[2].trim() };
    return { name: s.trim(), args: "" };
  }

  // Junta el texto de una condición hasta la « { », permitiendo « ; » adentro
  // (p. ej. un header de for de C: "int i = 0; i < n; i += 1"). Reinserta los « ; »
  // y corta en « { », « } » o salto de línea. No consume la « { ».
  function gatherCond(toks, i, rest) {
    var parts = rest ? [rest] : [];
    while (i.v < toks.length) {
      var t = toks[i.v];
      if (t.k === "{" || t.k === "}" || t.k === "nl") break;
      if (t.k === ";") parts.push(";");
      else if (t.k === "t") parts.push(t.s);
      else break;
      i.v++;
    }
    var s = parts.length ? parts[0] : "";
    for (var k = 1; k < parts.length; k++) {
      if (parts[k] === ";") s += "; ";
      else s += (/;\s$/.test(s) ? "" : " ") + parts[k];
    }
    return s.trim();
  }

  function parseStatement(toks, i, err) {
    var head = toks[i.v].s; i.v++;
    if (head.charAt(0) === "#") return D.comment(head.slice(1).trim());   // comentario
    var wm = head.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ]+)/);
    var word = wm ? wm[1].toLowerCase() : "";
    var rest = head.slice(word.length).trim();

    switch (word) {
      case "si": {
        var cond = rest;
        expectBrace(toks, i, err);
        var thenN = parseBlock(toks, i, true, err);
        var elseN = [];
        var j = i.v;
        while (j < toks.length && (toks[j].k === "nl" || toks[j].k === ";")) j++;
        if (toks[j] && toks[j].k === "t" && /^sino\b/i.test(toks[j].s)) {
          i.v = j + 1;
          expectBrace(toks, i, err);
          elseN = parseBlock(toks, i, true, err);
        }
        return D["if"](cond, thenN, elseN);
      }
      case "mientras": {
        var mc = gatherCond(toks, i, rest);   // admite « ; » (header estilo C) mostrado tal cual
        expectBrace(toks, i, err);
        return D["while"](mc, parseBlock(toks, i, true, err));
      }
      case "para": {
        var pm = rest.match(/^(.+?)\s+de\s+(.+)\s+a\s+(.+)$/i);
        var counter = "i", a = "", b = "";
        if (pm) { counter = pm[1].trim(); a = pm[2].trim(); b = pm[3].trim(); }
        else err.push("« para » esperaba: para i de A a B");
        expectBrace(toks, i, err);
        return D["for"](counter, a, b, parseBlock(toks, i, true, err));
      }
      case "procedimiento": {
        var cpp = callParts(rest);
        expectBrace(toks, i, err);
        var bodyP = parseBlock(toks, i, true, err);
        // el procedimiento termina siempre con retorno (R) implícito
        return D.seq([D.invoke(cpp.name, cpp.args)].concat(bodyP).concat([D.marker("R")]));
      }
      case "funcion": {
        var cpf = callParts(rest);
        expectBrace(toks, i, err);
        var bodyF = parseBlock(toks, i, true, err);
        // la función NO tiene retorno implícito: se escribe explícito con "retorno expr"
        return D.seq([D.invoke(cpf.name, cpf.args)].concat(bodyF));
      }
      case "programaprincipal": {
        expectBrace(toks, i, err);
        var bodyMain = parseBlock(toks, i, true, err);
        // sin encabezado: la marca (I) hace de encabezado y (F) cierra
        return D.seq([D.marker("I")].concat(bodyMain).concat([D.marker("F")]));
      }
      case "registro": {
        expectBrace(toks, i, err);
        var raw = [];
        while (i.v < toks.length && toks[i.v].k !== "}") { if (toks[i.v].k === "t") raw.push(toks[i.v].s); i.v++; }
        if (toks[i.v] && toks[i.v].k === "}") i.v++; else err.push("falta « } » en registro");
        var fields = raw.join(",").split(",").map(function (x) { return x.trim(); }).filter(Boolean)
          .map(function (f) { var pp = f.split(":"); return [(pp[0] || "").trim(), (pp[1] || "").trim()]; });
        return D.struct(fields, rest || null);   // rest = nombre del registro (título opcional)
      }
      case "leer": {
        var mIn = rest.match(/^([\s\S]*?)\s+desde\s+([\s\S]+)$/i);
        return mIn ? D.input(mIn[1].trim(), mIn[2].trim()) : D.input(rest);
      }
      case "escribir": {
        var mOut = rest.match(/^([\s\S]*?)\s+hacia\s+([\s\S]+)$/i);
        return mOut ? D.output(mOut[1].trim(), mOut[2].trim()) : D.output(rest);
      }
      case "invocar": { var c = callParts(rest); return D.invoke(c.name, c.args); }
      case "inicio": return D.marker("I");
      case "fin": return D.marker("F");
      case "retorno": return rest ? D.ret(rest) : D.marker("R");
      case "conector": return D.connector(rest);
      case "locales": {
        expectBrace(toks, i, err);
        var lines = [];
        while (i.v < toks.length && toks[i.v].k !== "}") { if (toks[i.v].k === "t") lines.push(toks[i.v].s); i.v++; }
        if (toks[i.v] && toks[i.v].k === "}") i.v++; else err.push("falta « } » en locales");
        return D.locals(lines.join("\n"));
      }
      default: {
        var opm = head.match(/^([\s\S]*?)\s*(:=|\+=|-=)\s*([\s\S]*)$/);
        if (opm) {
          var op = opm[2];
          return D.assign(opm[1].trim(), opm[3].trim(), op === ":=" ? undefined : op);
        }
        err.push("no entiendo: “" + head + "”");
        return null;
      }
    }
  }

  D.parse = function (src) {
    var err = [], toks = tokenize(src), i = { v: 0 };
    var nodes = parseBlock(toks, i, false, err);
    return { node: D.seq(nodes), errors: err };
  };

})(window);
