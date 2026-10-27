/* A read-only canvas view: stored coordinates never change. */
class ConstructiconGraph {
  constructor(canvas, data, onSelect, { initialZoom = 1, onDeselect = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.display = data.display || { labels: data.hulls ? "all" : "families", fontSize: 14, motionAmplitude: 3, labelGap: 5 };
    this.nodes = data.nodes.map((node, index) => ({ ...node, phase: index * 2.399, dx: 0, dy: 0 }));
    this.labelOrder = [...this.nodes].sort((a, b) => b.r - a.r);
    this.byId = new Map(this.nodes.map(node => [node.id, node]));
    this.edges = [];
    const edgeGroups = new Map();
    for (const edge of data.edges) {
      const pair = [this.byId.get(edge.source), this.byId.get(edge.target)];
      if (!pair.every(Boolean)) continue;
      this.edges.push(pair);
      const kind = edge.kind || "default";
      const color = kind === "primary" ? pair.find(node => node.type === "base")?.color : "#64748b";
      const key = `${kind}:${color}`;
      if (!edgeGroups.has(key)) edgeGroups.set(key, { kind, color, edges: [] });
      edgeGroups.get(key).edges.push(pair);
    }
    this.edgeGroups = [...edgeGroups.values()];
    this.familyRegions = data.familyRegions || [];
    this.parentEdges = this.buildParentIndex();
    this.childEdges = this.buildChildIndex();
    this.highlightedNodes = new Set();
    this.highlightedEdges = new Set();
    this.hulls = data.hulls || [];
    this.onSelect = onSelect;
    this.onDeselect = onDeselect;
    this.initialZoom = initialZoom;
    this.camera = { x: 0, y: 0, scale: 1 };
    this.motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    this.paused = this.motionQuery.matches;
    this.selected = null;
    this.hovered = null;
    this.frame = null;
    this.visible = true;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(entries => {
      this.visible = entries[0].isIntersecting;
      this.restart();
    });
    this.intersectionObserver.observe(canvas);
    this.motionQuery.addEventListener("change", event => {
      this.paused = event.matches;
      this.updateMotionButton();
      this.restart();
    });
    document.addEventListener("visibilitychange", () => this.restart());
    this.bindControls();
    this.resize();
    this.updateMotionButton();
  }

  resize() {
    // ResizeObserver also fires after construction. Preserve the relative zoom
    // so its first callback cannot erase the requested opening magnification.
    const zoomFactor = this.fitScale > 0 ? this.camera.scale / this.fitScale : this.initialZoom;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.fit(zoomFactor);
  }

  fit(zoomFactor = 1) {
    if (!this.nodes.length) return;
    const bounds = this.nodes.map(node => {
      const labeled = this.display.labels === "all" || !["word", "neo"].includes(node.type);
      const width = labeled ? node.label.length * this.display.fontSize * .61 : 0;
      const margin = this.display.motionAmplitude + 5;
      return {
        left: node.x - Math.max(node.r, width / 2) - margin,
        right: node.x + Math.max(node.r, width / 2) + margin,
        top: node.y - node.r - (labeled ? this.display.fontSize + this.display.labelGap : 0) - margin,
        bottom: node.y + node.r + margin,
      };
    });
    for (const region of this.familyRegions || []) {
      bounds.push({ left: region.x - region.r, right: region.x + region.r,
        top: region.y - region.r, bottom: region.y + region.r });
    }
    const minX = Math.min(...bounds.map(b => b.left)), maxX = Math.max(...bounds.map(b => b.right));
    const minY = Math.min(...bounds.map(b => b.top)), maxY = Math.max(...bounds.map(b => b.bottom));
    this.fitScale = Math.min(
      (this.width - 40) / (maxX - minX),
      (this.height - 85) / (maxY - minY)
    );
    const scale = this.fitScale * zoomFactor;
    this.camera = {
      scale,
      x: this.width / 2 - (minX + maxX) / 2 * scale,
      y: (this.height + 35) / 2 - (minY + maxY) / 2 * scale,
    };
    this.restart();
  }

  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const next = Math.max(this.fitScale * .5, Math.min(this.fitScale * (this.display.maxZoomFactor ?? 25), this.camera.scale * factor));
    const ratio = next / this.camera.scale;
    this.camera.x = x - (x - this.camera.x) * ratio;
    this.camera.y = y - (y - this.camera.y) * ratio;
    this.camera.scale = next;
    this.restart();
  }

  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  hit(point) {
    let result = null, distance = Infinity;
    const { x, y, scale } = this.camera;
    for (const node of this.nodes) {
      const dx = point.x - ((node.x + node.dx) * scale + x);
      const dy = point.y - ((node.y + node.dy) * scale + y);
      const d = dx * dx + dy * dy;
      const radius = Math.max(6, node.r * scale);
      if (d <= radius * radius && d < distance) {
        result = node;
        distance = d;
      }
    }
    return result;
  }

  buildParentIndex() {
    const parents = new Map(this.nodes.map(node => [node.id, []]));
    for (const edge of this.edges) {
      const [a, b] = edge;
      // Main-family edges are undirected in NetworkX; specific-network edges
      // already run from parent to child. Keep the original edge for drawing.
      const [parent, child] = b.type === "base" ? [b, a] : [a, b];
      parents.get(child.id).push({ parent, edge });
    }
    return parents;
  }

  select(id) {
    this.selected = this.byId.get(id) || null;
    this.highlightedNodes.clear();
    this.highlightedEdges.clear();
    // Traverse each direction separately: visiting a mother must not expand
    // into siblings or into the other families of a shared descendant.
    this.highlightBranch(this.parentEdges, "parent");
    this.highlightBranch(this.childEdges, "child");
    this.restart();
  }

  buildChildIndex() {
    const children = new Map(this.nodes.map(node => [node.id, []]));
    for (const [childId, parents] of this.parentEdges) {
      for (const { parent, edge } of parents) {
        children.get(parent.id).push({ child: this.byId.get(childId), edge });
      }
    }
    return children;
  }

  highlightBranch(index, direction) {
    const visited = new Set();
    const pending = this.selected ? [this.selected] : [];
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      this.highlightedNodes.add(node.id);
      for (const connection of index.get(node.id) || []) {
        this.highlightedEdges.add(connection.edge);
        pending.push(connection[direction]);
      }
    }
  }

  bindControls() {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      this.hoverPoint = null;
      this.drag = { ...this.point(event), start: this.point(event), moved: false, id: event.pointerId };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      const point = this.point(event);
      if (this.drag && event.pointerId === this.drag.id) {
        this.drag.moved ||= Math.hypot(point.x - this.drag.start.x, point.y - this.drag.start.y) > 5;
        if (this.drag.moved) {
          this.camera.x += point.x - this.drag.x;
          this.camera.y += point.y - this.drag.y;
        }
        this.drag.x = point.x;
        this.drag.y = point.y;
      } else {
        // Only hit-test the latest pointer position on the next display frame.
        this.hoverPoint = point;
      }
      this.restart();
    });
    canvas.addEventListener("pointerup", event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      if (!this.drag.moved) {
        const node = this.hit(this.point(event));
        if (node) {
          this.select(node.id);
          this.onSelect(node);
        } else {
          this.hovered = null;
          document.querySelector("#node-tooltip").hidden = true;
          canvas.style.cursor = "grab";
          this.select(null);
          this.onDeselect();
        }
      }
      this.drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointercancel", () => { this.drag = null; });
    canvas.addEventListener("lostpointercapture", () => { this.drag = null; });
    canvas.addEventListener("pointerleave", () => {
      this.hoverPoint = null;
      this.hovered = null;
      document.querySelector("#node-tooltip").hidden = true;
      this.restart();
    });
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const point = this.point(event);
      this.zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .002), point.x, point.y);
    }, { passive: false });
    document.querySelector("#zoom-in").addEventListener("click", () => this.zoom(1.4));
    document.querySelector("#zoom-out").addEventListener("click", () => this.zoom(1 / 1.4));
    document.querySelector("#fit-graph").addEventListener("click", () => this.fit());
    document.querySelector("#toggle-motion").addEventListener("click", () => {
      this.paused = !this.paused;
      this.updateMotionButton();
      this.restart();
    });
  }

  updateMotionButton() {
    const button = document.querySelector("#toggle-motion");
    button.textContent = this.paused ? "RESUME MOTION" : "PAUSE MOTION";
    button.setAttribute("aria-pressed", String(this.paused));
  }

  restart() {
    // Input can arrive several times per display frame. Keep its latest state
    // and share one scheduled paint with the animation, including while paused.
    this.dirty = true;
    if (document.hidden || !this.visible) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      return;
    }
    if (this.frame === null) this.frame = requestAnimationFrame(time => this.tick(time));
  }

  tick(time) {
    this.frame = null;
    if (document.hidden || !this.visible) return;
    if (this.hoverPoint) {
      const hovered = this.hit(this.hoverPoint);
      this.hoverPoint = null;
      if (hovered !== this.hovered) {
        this.hovered = hovered;
        const tooltip = document.querySelector("#node-tooltip");
        tooltip.hidden = !hovered;
        tooltip.textContent = hovered?.label || "";
        this.canvas.style.cursor = hovered ? "pointer" : "grab";
      }
    }
    if (this.dirty || (!this.paused &&
        (this.lastDraw == null || time - this.lastDraw >= (this.display.motionFrameInterval ?? 0)))) {
      this.draw(time);
      this.lastDraw = time;
      this.dirty = false;
    }
    if (!this.paused) this.frame = requestAnimationFrame(next => this.tick(next));
  }

  draw(time) {
    const ctx = this.ctx;
    const { x, y, scale } = this.camera;
    // Conservative world-space clipping retains links crossing the viewport
    // even when both endpoints are outside, plus room for stroke widths.
    const padding = Math.max(3 / scale, (this.display.edgeWidth ?? 0) / 2,
      (this.display.secondaryEdgeWidth ?? .45) / 2, .325);
    const left = -x / scale - padding, right = (this.width - x) / scale + padding;
    const top = -y / scale - padding, bottom = (this.height - y) / scale + padding;
    const edgeVisible = (a, b) => !(
      (a.x + a.dx < left && b.x + b.dx < left) ||
      (a.x + a.dx > right && b.x + b.dx > right) ||
      (a.y + a.dy < top && b.y + b.dy < top) ||
      (a.y + a.dy > bottom && b.y + b.dy > bottom));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    const motionTime = time * (this.display.motionSpeed ?? 1);
    for (const node of this.nodes) {
      const amplitude = this.paused ? 0 : (node.motionAmplitude ?? this.display.motionAmplitude) * (this.display.motionAmplitudeScale ?? 1);
      node.dx = Math.sin(motionTime * .0026 + node.phase) * amplitude;
      node.dy = Math.cos(motionTime * .0021 + node.phase) * amplitude;
    }
    for (const hull of this.hulls) {
      if (!hull.points?.length) continue;
      ctx.beginPath();
      hull.points.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
      ctx.closePath();
      ctx.globalAlpha = hull.alpha || .1;
      ctx.fillStyle = hull.fill;
      ctx.fill();
    }
    for (const region of this.familyRegions || []) {
      if (region.x + region.r < left || region.x - region.r > right ||
          region.y + region.r < top || region.y - region.r > bottom) continue;
      ctx.beginPath();
      ctx.arc(region.x, region.y, region.r, 0, Math.PI * 2);
      ctx.fillStyle = region.color;
      ctx.globalAlpha = .04;
      ctx.fill();
      ctx.strokeStyle = region.color;
      ctx.globalAlpha = this.selected && !this.highlightedNodes.has(region.id) ? .2 : .55;
      ctx.lineWidth = .65;
      ctx.stroke();
    }
    for (const group of this.edgeGroups || [{ kind: "default", edges: this.edges }]) {
      const secondary = group.kind === "secondary";
      ctx.globalAlpha = (secondary ? (this.display.secondaryEdgeAlpha ?? .15) : (this.display.edgeAlpha ?? .17)) * (this.selected ? .45 : 1);
      ctx.strokeStyle = group.kind === "default" ? "#383838" : group.color;
      ctx.lineWidth = secondary ? (this.display.secondaryEdgeWidth ?? .45) : (this.display.edgeWidth ?? .65 / scale);
      // Keep dashes readable at overview scale instead of rasterizing thousands
      // of subpixel segments. At closer zoom the original world-space pattern wins.
      const dash = Math.max(3, 1.5 / scale);
      ctx.setLineDash(secondary ? [dash, dash] : []);
      ctx.beginPath();
      for (const [a, b] of group.edges) {
        if (!edgeVisible(a, b)) continue;
        ctx.moveTo(a.x + a.dx, a.y + a.dy);
        ctx.lineTo(b.x + b.dx, b.y + b.dy);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Draw selected ancestry and descendants above the subdued background edges.
    if (this.highlightedEdges.size) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#314fe0";
      ctx.lineWidth = 2.5 / scale;
      ctx.beginPath();
      for (const [a, b] of this.highlightedEdges) {
        if (!edgeVisible(a, b)) continue;
        ctx.moveTo(a.x + a.dx, a.y + a.dy);
        ctx.lineTo(b.x + b.dx, b.y + b.dy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const visible = new Set();
    for (const node of this.nodes) {
      const px = (node.x + node.dx) * scale + x;
      const py = (node.y + node.dy) * scale + y;
      const padding = Math.max(50, node.r * scale);
      if (px < -padding || px > this.width + padding || py < -padding || py > this.height + padding) continue;
      visible.add(node);
      const related = this.highlightedNodes.has(node.id);
      ctx.globalAlpha = related ? 1 : ["base", "center"].includes(node.type)
        ? (this.display.baseAlpha ?? .95) : (this.display.wordAlpha ?? .68);
      if (this.selected && !related) ctx.globalAlpha *= .5;
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.x + node.dx, node.y + node.dy, node.r, 0, Math.PI * 2);
      ctx.fill();
      if (related || node === this.hovered) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = node === this.selected || node === this.hovered ? "#111" : "#314fe0";
        ctx.lineWidth = (node === this.selected ? 3 : 2) / scale;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#111";
    ctx.textAlign = "center";
    let labels = 0;
    const labelBoxes = [];
    const isActive = node => this.highlightedNodes.has(node.id) || node === this.hovered;
    const labelNodes = [...visible].filter(isActive);
    for (const node of this.labelOrder) {
      if (visible.has(node) && !isActive(node)) labelNodes.push(node);
    }
    for (const node of labelNodes) {
      const important = !["word", "neo"].includes(node.type);
      const active = this.highlightedNodes.has(node.id) || node === this.hovered;
      const persistent = this.display.labels === "all" || important;
      if (!persistent && !active &&
          (scale < this.fitScale * 4 || labels > 250)) continue;
      const centered = persistent && this.display.labelPosition === "center";
      const fontSize = centered && this.display.fitLabelsToNodes !== false
        ? Math.min(this.display.fontSize, node.r * 1.8 / (node.label.length * .61))
        : persistent ? this.display.fontSize : 11 / scale;
      ctx.textBaseline = centered ? "middle" : "alphabetic";
      ctx.font = `${this.display.labelWeight || (important ? "bold" : "normal")} ${fontSize}px ${this.display.fontFamily || '"Courier New", monospace'}`;
      // Keep one measurement per node; camera movement does not change it.
      if (node.labelFont !== ctx.font) {
        node.labelFont = ctx.font;
        node.labelWidth = ctx.measureText(node.label).width;
      }
      const width = node.labelWidth * scale;
      const labelX = (node.x + node.dx) * scale + x;
      const textY = node.y + node.dy - (centered ? 0 : node.r + this.display.labelGap);
      const labelY = textY * scale + y;
      const box = { left: labelX - width / 2 - 3, right: labelX + width / 2 + 3, top: labelY - fontSize * scale, bottom: labelY + 3 };
      if (!persistent && !active && labelBoxes.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
      labelBoxes.push(box);
      ctx.fillStyle = this.highlightedNodes.has(node.id) && node !== this.selected ? "#243bb0" : "#111";
      if (this.display.labelHalo) {
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2 / scale;
        ctx.strokeText(node.label, node.x + node.dx, textY);
      }
      ctx.fillText(node.label, node.x + node.dx, textY);
      labels++;
    }
  }
}
window.ConstructiconGraph = ConstructiconGraph;
