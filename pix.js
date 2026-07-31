import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  push,
  set,
  get,
  remove,
  update,
  runTransaction,
} from "firebase/database";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";

// ---- CONFIGURAÇÃO FIREBASE ----
const firebaseConfig = {
  apiKey: "AIzaSyBSufzO0XqpLJ042F0Uwx4XYOwQ42-YHAo",
  authDomain: "inscr-d8712.firebaseapp.com",
  databaseURL: "https://inscr-d8712-default-rtdb.firebaseio.com",
  projectId: "inscr-d8712",
  storageBucket: "inscr-d8712.firebasestorage.app",
  messagingSenderId: "776446988108",
  appId: "1:776446988108:web:ea8a03286d587abc8bc9e9",
};

const LIMITE_MEDALHA = 7;
let db, auth, adminLogado = false;
let mostrarDuplicatas = false;

// Inicializa Firebase
let app;
try {
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  auth = getAuth(app);
  console.log("Firebase inicializado com sucesso.");
} catch (e) {
  console.error("Erro ao inicializar Firebase:", e);
  alert(
    "Erro ao conectar ao banco de dados. Verifique sua conexão e tente novamente."
  );
}

// ---- FUNÇÕES AUXILIARES ----
function toast(msg, bg = "#1e4a2f") {
  const d = document.createElement("div");
  d.className = "toast-custom";
  d.style.backgroundColor = bg;
  d.innerHTML = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}
window.toastPix = toast; // expõe para funções Pix

function esc(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[m]
  );
}

function validarFormulario() {
  let valido = true;
  const campos = ["nome", "cidade", "equipe", "idade", "genero"].map((id) =>
    document.getElementById(id)
  );
  campos.forEach((c) => c?.classList.remove("erro"));

  const nome = document.getElementById("nome");
  const cidade = document.getElementById("cidade");
  const equipe = document.getElementById("equipe");
  const idade = document.getElementById("idade");
  const genero = document.getElementById("genero");

  if (!nome?.value.trim()) {
    nome?.classList.add("erro");
    valido = false;
  }
  if (!cidade?.value.trim()) {
    cidade?.classList.add("erro");
    valido = false;
  }
  if (!equipe?.value.trim()) {
    equipe?.classList.add("erro");
    valido = false;
  }
  const idadeNum = parseInt(idade?.value, 10);
  if (!idade?.value.trim() || isNaN(idadeNum) || idadeNum < 1 || idadeNum > 120) {
    idade?.classList.add("erro");
    valido = false;
  }
  if (!genero?.value) {
    genero?.classList.add("erro");
    valido = false;
  }
  if (!valido) toast("❌ Preencha TODOS os campos obrigatórios!", "#c0392b");
  return valido;
}

function obterMedalhistasIds(inscricoes) {
  const ordenadas = [...inscricoes].sort(
    (a, b) => (a.dataCriacao || 0) - (b.dataCriacao || 0)
  );
  return new Set(ordenadas.slice(0, LIMITE_MEDALHA).map((i) => i.id));
}

// ---- OPERAÇÕES BANCO ----
async function obterTodasOrdenadas() {
  const snap = await get(ref(db, "inscricoes"));
  const todas = snap.val() || {};
  return Object.entries(todas)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.dataCriacao || 0) - (b.dataCriacao || 0));
}

async function criarInscricaoGratuita(dados) {
  const newRef = push(ref(db, "inscricoes"));
  const now = Date.now();
  const numero = await obterProximoNumeroInscricao();
  const registro = {
    nome: dados.nome.trim(),
    cidade: dados.cidade.trim(),
    equipe: dados.equipe.trim(),
    idade: Number(dados.idade),
    genero: dados.genero,
    pago: true,
    pdfEnviado: false,
    pagamentoConfirmadoPix: false,
    dataCriacao: now,
    dataPagamento: now,
    codigoInterno: "Amadores de bike" + newRef.key.slice(-6).toUpperCase(),
    numero: numero,
  };
  await set(newRef, registro);
  return { id: newRef.key, ...registro };
}

async function obterProximoNumeroInscricao() {
  const metaRef = ref(db, "meta/inscricaoCount");
  try {
    const result = await runTransaction(metaRef, (current) => {
      if (current === null) return 1;
      return current + 1;
    });
    if (result.committed) return result.snapshot.val();
    else throw new Error("Transaction falhou");
  } catch (error) {
    console.error("Erro ao obter próximo número:", error);
    const snapshot = await get(ref(db, "inscricoes"));
    const inscricoes = snapshot.val() || {};
    let max = 0;
    for (const key in inscricoes) {
      const num = inscricoes[key].numero;
      if (typeof num === "number" && num > max) max = num;
    }
    return max + 1;
  }
}

async function migrarNumerosAntigos() {
  const snapshot = await get(ref(db, "inscricoes"));
  const inscricoes = snapshot.val();
  if (!inscricoes) return;
  const precisaMigracao = Object.values(inscricoes).some(
    (ins) => ins.numero === undefined
  );
  if (!precisaMigracao) return;
  toast("🔄 Atualizando números das inscrições existentes...", "#e67e22");
  const entradas = Object.entries(inscricoes);
  entradas.sort((a, b) => (a[1].dataCriacao || 0) - (b[1].dataCriacao || 0));
  let contador = 1;
  for (let i = 0; i < entradas.length; i++) {
    const [id, dados] = entradas[i];
    if (dados.numero === undefined) {
      await update(ref(db, `inscricoes/${id}`), { numero: contador });
      contador++;
    }
  }
  const maior = await obterMaiorNumeroExistente();
  await set(ref(db, "meta/inscricaoCount"), maior);
  toast("✅ Migração concluída! Números fixos atribuídos.", "#15803d");
}

async function obterMaiorNumeroExistente() {
  const snapshot = await get(ref(db, "inscricoes"));
  const inscricoes = snapshot.val() || {};
  let max = 0;
  for (const key in inscricoes) {
    const num = inscricoes[key].numero;
    if (typeof num === "number" && num > max) max = num;
  }
  return max;
}

async function togglePagamentoPix(id, estadoAtual) {
  const novoEstado = !estadoAtual;
  await update(ref(db, `inscricoes/${id}`), {
    pagamentoConfirmadoPix: novoEstado,
  });
  return novoEstado;
}

async function togglePdfEnviado(id, estadoAtual) {
  const novoEstado = !estadoAtual;
  await update(ref(db, `inscricoes/${id}`), { pdfEnviado: novoEstado });
  return novoEstado;
}

async function marcarComoEnviado(id) {
  await update(ref(db, `inscricoes/${id}`), { pdfEnviado: true });
}

async function atualizarInscricao(id, nome, equipe) {
  await update(ref(db, `inscricoes/${id}`), {
    nome: nome.trim(),
    equipe: equipe.trim(),
  });
}

// ---- GERADOR DE PDF ----
async function gerarPDFRapido(reg) {
  if (typeof window.jspdf === "undefined" || !window.jspdf.jsPDF) {
    toast("jsPDF não carregado.", "#c0392b");
    return;
  }
  try {
    const todas = await obterTodasOrdenadas();
    const medalhistasIds = obterMedalhistasIds(todas);
    const ganhaMedalha = medalhistasIds.has(reg.id);
    const numeroInscricao = reg.numero || 0;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const marginX = 15;
    const dataEvento = "06/08/2026";

    doc.setFillColor(30, 74, 47);
    doc.rect(0, 0, pageWidth, 38, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont("helvetica", "bold");
    doc.text("AMADORES DE BIKE", pageWidth / 2, 18, { align: "center" });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Comprovante de Inscrição — Amadores de bike • ${dataEvento} • Pago`,
      pageWidth / 2,
      30,
      { align: "center" }
    );

    const boxY = 48;
    doc.setDrawColor(134, 239, 172);
    doc.setFillColor(240, 253, 244);
    doc.rect(marginX, boxY, pageWidth - marginX * 2, 32, "FD");
    doc.setFontSize(11);
    doc.setTextColor(21, 128, 61);
    doc.text("NÚMERO OFICIAL", pageWidth / 2, boxY + 8, {
      align: "center",
    });
    doc.setFontSize(36);
    doc.setFont("helvetica", "bold");
    doc.text(`#${numeroInscricao}`, pageWidth / 2, boxY + 27, {
      align: "center",
    });

    let afterMedalY = boxY + 42;

    if (ganhaMedalha) {
      const mY = boxY + 40;
      const mH = 52;
      const textX = marginX + 44;

      doc.setFillColor(255, 248, 195);
      doc.setDrawColor(212, 160, 23);
      doc.setLineWidth(1.5);
      doc.roundedRect(marginX, mY, pageWidth - marginX * 2, mH, 5, 5, "FD");
      doc.setLineWidth(0.5);

      const cx = marginX + 22;
      const medalTopY = mY + 8;

      doc.setFillColor(230, 57, 70);
      doc.triangle(cx - 7, medalTopY, cx, medalTopY + 10, cx - 7, medalTopY + 10, "F");
      doc.setFillColor(168, 0, 0);
      doc.triangle(cx + 7, medalTopY, cx, medalTopY + 10, cx + 7, medalTopY + 10, "F");
      doc.setFillColor(220, 50, 60);
      doc.rect(cx - 7, medalTopY, 14, 6, "F");
      doc.setFillColor(180, 130, 0);
      doc.circle(cx, medalTopY + 24, 11, "F");
      doc.setFillColor(212, 160, 23);
      doc.circle(cx, medalTopY + 24, 10, "F");
      doc.setFillColor(255, 220, 50);
      doc.circle(cx, medalTopY + 24, 8, "F");
      doc.setFillColor(255, 240, 100);
      doc.circle(cx, medalTopY + 24, 6.5, "F");

      const starX = cx,
        starY = medalTopY + 24;
      const outerR = 5,
        innerR = 2.2;
      const points = [];
      for (let i = 0; i < 10; i++) {
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        points.push([starX + r * Math.cos(angle), starY + r * Math.sin(angle)]);
      }
      doc.setFillColor(180, 110, 0);
      doc.setDrawColor(180, 110, 0);
      doc.lines(
        points
          .slice(1)
          .map((p, i) => [p[0] - points[i][0], p[1] - points[i][1]]),
        points[0][0],
        points[0][1],
        [1, 1],
        "F",
        true
      );

      doc.setFillColor(212, 160, 23);
      doc.roundedRect(
        textX,
        mY + 5,
        pageWidth - marginX - textX - 4,
        9,
        2,
        2,
        "F"
      );
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 30, 0);
      doc.text(
        `PRIMEIROS ${LIMITE_MEDALHA} INSCRITOS`,
        textX + (pageWidth - marginX - textX - 4) / 2,
        mY + 11.5,
        { align: "center" }
      );

      doc.setFontSize(13.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 45, 0);
      doc.text("MEDALHA ESPECIAL", textX + 2, mY + 27);

      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(140, 70, 0);
      doc.text("GARANTIDA!", textX + 2, mY + 36);

      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(120, 60, 0);
      doc.text("Retire no evento com este comprovante.", textX + 2, mY + 46);

      afterMedalY = mY + mH + 6;
    }

    const equipeExib =
      reg.equipe && reg.equipe.trim() !== "" ? reg.equipe : "Não informada";

    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    doc.setLineWidth(0.5);

    doc.autoTable({
      startY: afterMedalY,
      body: [
        ["Nome:", reg.nome],
        ["Cidade:", reg.cidade],
        ["Equipe:", equipeExib],
        ["Idade:", reg.idade || "—"],
        ["Gênero:", reg.genero],
        [
          "Medalha:",
          ganhaMedalha
            ? `SIM — Primeiros ${LIMITE_MEDALHA} inscritos`
            : "Não elegível",
        ],
        ["Status:", "CONFIRMADA"],
        ["Data do evento:", dataEvento],
        [
          "Inscrição realizada:",
          new Date(reg.dataCriacao).toLocaleString("pt-BR"),
        ],
      ],
      theme: "plain",
      styles: { fontSize: 10, cellPadding: 3 },
      columnStyles: {
        0: { fontStyle: "bold", textColor: [30, 74, 47], cellWidth: 45 },
      },
      margin: { left: marginX, right: marginX },
    });

    const finalY = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text(
      "Amadores de bike • Apresente este comprovante no dia 06/08/2026",
      pageWidth / 2,
      finalY,
      { align: "center" }
    );

    doc.save(
      `amadores de bike_${reg.nome.replace(/\s/g, "_")}_${numeroInscricao}.pdf`
    );
    toast(
      `PDF gerado! Nº #${numeroInscricao}${ganhaMedalha ? " 🏅" : ""}`,
      "#2e7d32"
    );
  } catch (e) {
    toast("Erro PDF: " + e.message, "#c0392b");
  }
}

async function enviarPdfSemWhats(reg, btnEl) {
  try {
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    await gerarPDFRapido(reg);
    await marcarComoEnviado(reg.id);
    if (btnEl) btnEl.disabled = false;
    carregarAdminUI();
    toast(`✅ PDF gerado e marcado como enviado para ${reg.nome}!`, "#15803d");
  } catch (err) {
    toast("Erro: " + err.message, "#c0392b");
    if (btnEl) btnEl.disabled = false;
  }
}

// ---- INTERFACE ----
async function mostrarConfirmacao(registro) {
  const todas = await obterTodasOrdenadas();
  const medalhistasIds = obterMedalhistasIds(todas);
  const ganhaMedalha = medalhistasIds.has(registro.id);
  const numero = registro.numero;

  const container = document.getElementById("confirmadoDinamico");
  const equipeExib =
    registro.equipe && registro.equipe.trim() !== ""
      ? registro.equipe
      : "Não informada";

  const medalhaHTML = ganhaMedalha
    ? `
      <div class="medalha-container">
        <span class="medalha-icone">🏅</span>
        <div class="medalha-titulo">Você ganhou uma medalha!</div>
        <div class="medalha-subtitulo">Está entre os primeiros ${LIMITE_MEDALHA} inscritos</div>
        <span class="medalha-faixa">Retire no evento (06/08/2026) • Apresente este comprovante</span>
      </div>
    `
    : "";

  container.innerHTML = `
    <div style="text-align:center;margin-bottom:16px">
      <div class="confirmed-avatar"><i class="fas fa-check-double"></i></div>
      <h2 style="font-size:1.5rem;font-weight:700;margin-top:12px;color:#15803d">Inscrição Confirmada!-faça o Pagamento em baixo</h2>
      <p style="color:#4b5563;margin-top:6px;">Evento: 06/08/2026</p>
    </div>
    ${medalhaHTML}
    <div class="confirmed-numero-box">
      <div class="confirmed-num-label"><i class="fas fa-hashtag"></i> SEU CÓDIGO COMPLETO</div>
      <div class="confirmed-num">#${esc(String(numero).padStart(3, "0"))}</div>
      <button id="copiarNumero" class="btn btn-green btn-sm" style="margin-top:10px">Copiar código</button>
    </div>
    <div id="pixSectionConfirmado"></div>
    <div class="confirmed-grid" style="margin-top:16px">
      <div class="confirmed-item"><div class="confirmed-item-label">Nome</div><div class="confirmed-item-value">${esc(registro.nome)}</div></div>
      <div class="confirmed-item"><div class="confirmed-item-label">Cidade</div><div class="confirmed-item-value">${esc(registro.cidade)}</div></div>
      <div class="confirmed-item"><div class="confirmed-item-label">Equipe</div><div class="confirmed-item-value">${esc(equipeExib)}</div></div>
    </div>
    <button id="baixarPdfConfirmadoBtn" class="btn btn-gray" style="margin-top:12px"><i class="fas fa-file-pdf"></i> Baixar comprovante PDF${ganhaMedalha ? " 🏅" : ""}</button>
  `;

  document.getElementById("tabConfirmadoBtn").classList.remove("tab-hidden");

  document.getElementById("copiarNumero")?.addEventListener("click", () => {
    navigator.clipboard.writeText(String(numero).padStart(3, "0"));
    toast(`Código #${String(numero).padStart(3, "0")} copiado!`, "#27ae60");
  });

  document.getElementById("baixarPdfConfirmadoBtn")?.addEventListener("click", () =>
    gerarPDFRapido(registro)
  );

  // Renderiza Pix com botão copiar chave e WhatsApp
  if (typeof window.renderizarPix === "function") {
    window.renderizarPix("pixSectionConfirmado", registro);
  }

  irParaTab("confirmado");
}

function getNomesDuplicados(inscricoes) {
  const freq = {};
  inscricoes.forEach((i) => {
    const nome = (i.nome || "").trim().toLowerCase();
    if (nome) freq[nome] = (freq[nome] || 0) + 1;
  });
  const duplicados = new Set();
  for (const [nome, count] of Object.entries(freq)) {
    if (count > 1) duplicados.add(nome);
  }
  return duplicados;
}

// ---- ADMIN UI ----
async function carregarAdminUI() {
  if (!adminLogado) return;

  const todas = await obterTodasOrdenadas();
  const total = todas.length;
  const enviados = todas.filter((i) => i.pdfEnviado).length;
  const medalhistasIds = obterMedalhistasIds(todas);
  const comMedalha = medalhistasIds.size;
  const pixPagos = todas.filter((i) => i.pagamentoConfirmadoPix === true).length;
  const duplicadosSet = getNomesDuplicados(todas);
  const qtdeDuplicados = duplicadosSet.size;

  document.getElementById("adminPanelRoot").innerHTML = `
    <div class="admin-stats">
      <div class="stat-card"><div class="stat-num">${total}</div><div>Total</div></div>
      <div class="stat-card"><div class="stat-num stat-enviados">${enviados}</div><div>PDF Enviados</div></div>
      <div class="stat-card"><div class="stat-num stat-pendentes">${total - enviados}</div><div>Pendentes</div></div>
      <div class="stat-card"><div class="stat-num" style="color:#d4a017">${comMedalha}</div><div>🏅 Medalhas</div></div>
      <div class="stat-card"><div class="stat-num" style="color:#2563eb">${pixPagos}</div><div>✅ Pix Pagos</div></div>
      <div class="stat-card"><div class="stat-num" style="color:#e67e22">${qtdeDuplicados}</div><div>Nomes duplicados</div></div>
    </div>

    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;align-items:center;">
      <button id="btnPdfCompletoAdmin" class="btn btn-green btn-sm"><i class="fas fa-file-pdf"></i> Relatório Completo</button>
      <button id="btnDuplicatas" class="btn btn-sm ${mostrarDuplicatas ? "btn-orange" : "btn-gray"}">
        ${mostrarDuplicatas ? "Ocultar" : "Mostrar"} Duplicatas
      </button>
      <input type="text" id="buscaAdmin" class="admin-search" placeholder="Buscar nome, cidade ou equipe...">
    </div>

    <div class="admin-legenda">
      <span>Legenda:</span>
      <span class="legenda-item"><span class="legenda-dot verde"></span> Enviado</span>
      <span class="legenda-item"><span class="legenda-dot vermelho"></span> Não enviado</span>
      <span class="legenda-item"><span style="font-size:.75rem">🏅</span> Medalha (primeiros ${LIMITE_MEDALHA})</span>
      <span class="legenda-item"><span style="background:#fef9c3;padding:0 6px;border-radius:4px;">Duplicado</span></span>
      <span class="legenda-item"><span style="background:#dbeafe;padding:0 6px;border-radius:4px;">✅ Pix confirmado</span></span>
    </div>

    <div class="admin-table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Nome</th><th>Cidade</th><th>Equipe</th><th>Código</th><th>Ações</th></tr>
        </thead>
        <tbody id="adminTableBody"></tbody>
      </table>
    </div>
  `;

  document.getElementById("btnDuplicatas")?.addEventListener("click", () => {
    mostrarDuplicatas = !mostrarDuplicatas;
    carregarAdminUI();
  });

  const render = (base) => {
    const busca = (document.getElementById("buscaAdmin")?.value || "").toLowerCase();
    const duplicados = getNomesDuplicados(todas);
    const medalhistas = obterMedalhistasIds(base);

    const filtrados = base.filter((i) => {
      const nomeLower = (i.nome || "").trim().toLowerCase();
      const matchBusca =
        (i.nome || "").toLowerCase().includes(busca) ||
        (i.cidade || "").toLowerCase().includes(busca) ||
        (i.equipe || "").toLowerCase().includes(busca);
      if (mostrarDuplicatas) {
        return matchBusca && duplicados.has(nomeLower);
      }
      return matchBusca;
    });

    const tbody = document.getElementById("adminTableBody");
    if (!tbody) return;

    tbody.innerHTML = filtrados
      .map((reg, idx) => {
        const equipeTabela =
          reg.equipe && reg.equipe.trim() !== "" ? reg.equipe : "—";
        const numero = reg.numero;
        const numFormatado = numero ? String(numero).padStart(3, "0") : "???";
        const medal = medalhistas.has(reg.id);
        const nomeLower = (reg.nome || "").trim().toLowerCase();
        const isDuplicado = duplicados.has(nomeLower);
        const pagConfirmado = reg.pagamentoConfirmadoPix === true;

        const rowClass = isDuplicado ? "row-duplicada" : "";

        return `
          <tr class="${rowClass}">
            <td>${idx + 1}</td>
            <td>
              <strong>${esc(reg.nome)}</strong>
              ${medal ? ' <span class="badge-medal">🏅 Medalha</span>' : ""}
              ${isDuplicado ? ' <span class="badge-duplicado">🔁 Duplicado</span>' : ""}
              ${pagConfirmado ? ' <span class="badge-duplicado" style="background:#dbeafe;border-color:#3b82f6;">✅ Pix</span>' : ""}
            </td>
            <td>${esc(reg.cidade)}</td>
            <td>${esc(equipeTabela)}</td>
            <td><span class="badge-numero">#${numFormatado}</span></td>
            <td>
              <button class="btn-action btn-pdf acao-pdf" data-id="${reg.id}"><i class="fas fa-file-pdf"></i> PDF</button>
              <button class="btn-action btn-edit acao-edit"
                data-id="${reg.id}"
                data-nome="${esc(reg.nome)}"
                data-equipe="${esc(equipeTabela)}">
                <i class="fas fa-pen"></i> Editar
              </button>
              <button class="btn-action btn-deletar acao-deletar" data-id="${reg.id}"><i class="fas fa-trash"></i> Excluir</button>
              <button class="btn-action ${reg.pdfEnviado ? "btn-pdf-enviado" : "btn-pdf-nao-enviado"} acao-toggle-pdf"
                data-id="${reg.id}" data-enviado="${reg.pdfEnviado}">
                <i class="fas ${reg.pdfEnviado ? "fa-check-circle" : "fa-times-circle"}"></i>
                ${reg.pdfEnviado ? "Enviado" : "Pendente"}
              </button>
              <button class="btn-action btn-pix-toggle ${pagConfirmado ? "pago" : ""} acao-toggle-pix"
                data-id="${reg.id}" data-pago="${pagConfirmado}">
                <i class="fas ${pagConfirmado ? "fa-check-circle" : "fa-circle"}"></i>
                ${pagConfirmado ? "Pago" : "Pix"}
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    document.querySelectorAll(".acao-pdf").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reg = filtrados.find((f) => f.id === btn.dataset.id);
        if (reg) await gerarPDFRapido(reg);
      });
    });

    document.querySelectorAll(".acao-deletar").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm("Excluir permanentemente?")) {
          await remove(ref(db, `inscricoes/${btn.dataset.id}`));
          toast("Excluída", "#c0392b");
          carregarAdminUI();
        }
      });
    });

    document.querySelectorAll(".acao-toggle-pdf").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const estadoAtual = btn.dataset.enviado === "true";
        try {
          btn.disabled = true;
          const novo = await togglePdfEnviado(id, estadoAtual);
          toast(novo ? "✅ Marcado enviado!" : "Marcado pendente", novo ? "#15803d" : "#e67e22");
          carregarAdminUI();
        } catch {
          toast("Erro", "#c0392b");
          carregarAdminUI();
        }
      });
    });

    document.querySelectorAll(".acao-toggle-pix").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const estadoAtual = btn.dataset.pago === "true";
        try {
          btn.disabled = true;
          const novo = await togglePagamentoPix(id, estadoAtual);
          toast(
            novo ? "✅ Pagamento Pix confirmado!" : "Pagamento Pix desmarcado",
            novo ? "#15803d" : "#e67e22"
          );
          carregarAdminUI();
        } catch {
          toast("Erro ao atualizar Pix", "#c0392b");
          carregarAdminUI();
        }
      });
    });

    document.querySelectorAll(".acao-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("editId").value = btn.dataset.id;
        document.getElementById("editNome").value = btn.dataset.nome;
        document.getElementById("editEquipe").value =
          btn.dataset.equipe === "—" ? "" : btn.dataset.equipe;
        document.getElementById("modalEdit").classList.remove("hidden");
      });
    });
  };

  render(todas);
  document.getElementById("buscaAdmin")?.addEventListener("input", () => render(todas));

  document.getElementById("btnPdfCompletoAdmin")?.addEventListener("click", async () => {
    const { jsPDF } = window.jspdf;
    const todasRel = await obterTodasOrdenadas();
    if (!todasRel.length) {
      toast("Nenhuma inscrição para gerar relatório.", "#c0392b");
      return;
    }
    const doc = new jsPDF("landscape");
    const pageWidth = doc.internal.pageSize.getWidth();
    const dataAtual = new Date().toLocaleString("pt-BR");
    const dataEvento = "06/08/2026";

    doc.setFillColor(30, 74, 47);
    doc.rect(0, 0, pageWidth, 32, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("Amadores de Bike", pageWidth / 2, 14, {
      align: "center",
    });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Relatório completo de inscrições • Evento: ${dataEvento} • Pago`,
      pageWidth / 2,
      25,
      { align: "center" }
    );

    const total = todasRel.length;
    const enviados = todasRel.filter((i) => i.pdfEnviado).length;
    const medalhistasIds = obterMedalhistasIds(todasRel);
    const medalhistas = medalhistasIds.size;
    const pendentes = total - enviados;
    const pixPagosRel = todasRel.filter((i) => i.pagamentoConfirmadoPix === true).length;

    const statsY = 38;
    doc.setFillColor(245, 245, 245);
    doc.roundedRect(14, statsY, pageWidth - 28, 34, 4, 4, "F");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.text(`Total: ${total}`, 20, statsY + 8);
    doc.text(`PDF enviados: ${enviados}`, 20, statsY + 16);
    doc.text(`Pendentes: ${pendentes}`, 20, statsY + 24);
    doc.text(`🏅 Medalhistas (≤ ${LIMITE_MEDALHA}): ${medalhistas}`, pageWidth - 80, statsY + 8);
    doc.text(`✅ Pix confirmados: ${pixPagosRel}`, pageWidth - 80, statsY + 16);
    doc.text(`📅 Gerado em: ${dataAtual}`, pageWidth - 80, statsY + 24);

    const rows = todasRel.map((r) => {
      const num = r.numero ? String(r.numero).padStart(3, "0") : "???";
      const medal = medalhistasIds.has(r.id) ? "Sim" : "Não";
      const pix = r.pagamentoConfirmadoPix === true ? "Sim" : "Não";
      return [
        num,
        r.nome,
        r.cidade,
        r.equipe || "—",
        r.idade || "—",
        r.genero || "—",
        medal,
        pix,
        r.pdfEnviado ? "Enviado" : "Pendente",
      ];
    });

    doc.autoTable({
      head: [
        [
          "Nº",
          "Nome",
          "Cidade",
          "Equipe",
          "Idade",
          "Gênero",
          `Medalha (≤${LIMITE_MEDALHA})`,
          "Pix confirmado",
          "PDF",
        ],
      ],
      body: rows,
      startY: statsY + 44,
      margin: { left: 14, right: 14 },
      styles: {
        fontSize: 7,
        cellPadding: 2,
        textColor: [0, 0, 0],
        lineColor: [200, 200, 200],
        lineWidth: 0.1,
      },
      headStyles: {
        fillColor: [30, 74, 47],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7,
      },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: {
        0: { cellWidth: 14, halign: "center" },
        1: { cellWidth: 45 },
        2: { cellWidth: 30 },
        3: { cellWidth: 35 },
        4: { cellWidth: 14, halign: "center" },
        5: { cellWidth: 22 },
        6: { cellWidth: 24, halign: "center" },
        7: { cellWidth: 22, halign: "center" },
        8: { cellWidth: 20, halign: "center" },
      },
      didParseCell: function (data) {
        if (data.section === "body") {
          const rowIndex = data.row.index;
          const reg = todasRel[rowIndex];
          if (reg && medalhistasIds.has(reg.id)) {
            data.cell.styles.fillColor = [255, 248, 195];
            data.cell.styles.textColor = [100, 45, 0];
          }
        }
      },
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(150, 150, 150);
      doc.text(
        `Página ${i} de ${pageCount} • Amadores de Bike • ${dataEvento}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 8,
        { align: "center" }
      );
    }

    doc.save("relatorio_amadores-bike_completo.pdf");
    toast("Relatório completo gerado com sucesso!", "#2e7d32");
  });
}

// ---- PIX (com botão copiar chave e WhatsApp) ----
window.PIX_CONFIG = {
  chave: "+5586995118130", // Chave Pix (telefone com DDI)
  beneficiario: "Marilene Nunes Maciel Sena",
  cidade: "Minguel Leão-PI",
  valor: 30.00,
};

// CRC16-CCITT
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(id, value) {
  const len = String(value.length).padStart(2, "0");
  return `${id}${len}${value}`;
}

function normalizarTexto(txt, tamanho) {
  return (txt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .substring(0, tamanho);
}

function montarPayloadPix({ chave, nome, cidade, valor, txid }) {
  const merchantAccount = tlv("00", "br.gov.bcb.pix") + tlv("01", chave);
  const merchantAccountInfo = tlv("26", merchantAccount);
  const nomeF = normalizarTexto(nome, 25);
  const cidadeF = normalizarTexto(cidade, 15);
  const txidLimpo =
    (txid || "***")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .substring(0, 25) || "***";
  const valorF = Number(valor).toFixed(2);
  let payload =
    tlv("00", "01") +
    tlv("01", "11") +
    merchantAccountInfo +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", valorF) +
    tlv("58", "BR") +
    tlv("59", nomeF) +
    tlv("60", cidadeF) +
    tlv("62", tlv("05", txidLimpo));
  payload += "6304";
  const crc = crc16(payload);
  return payload + crc;
}

window.renderizarPix = function renderizarPix(containerId, registro) {
  const config = window.PIX_CONFIG;
  const numero = registro.numero || 0;
  const txid = "Amadores-bike" + String(numero).padStart(6, "0");

  const payload = montarPayloadPix({
    chave: config.chave,
    nome: config.beneficiario,
    cidade: config.cidade,
    valor: config.valor,
    txid: txid,
  });

  const container = document.getElementById(containerId);
  if (!container) return;

  const chaveSemDDI = config.chave.replace(/^\+55/, "");

  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "pix-box";
  wrapper.innerHTML = `
    <div class="pix-titulo"><i class="fas fa-qrcode"></i> Contribuição via Pix </div>
    <div class="pix-valor">R$ ${config.valor.toFixed(2).replace(".", ",")}</div>
    <div id="pixQrCode-${containerId}" class="pix-qr"></div>
    <div class="pix-chave-area">
      <span class="pix-chave">${chaveSemDDI}</span>
      <button class="btn-copy-chave" id="copiarChavePix-${containerId}">
        <i class="fas fa-copy"></i> Copiar chave
      </button>
    </div>
    <div class="pix-obs">Beneficiário: ${config.beneficiario} • Ref: ${txid}</div>
  `;
  container.appendChild(wrapper);

  // Gera QR Code
  const qrEl = document.getElementById(`pixQrCode-${containerId}`);
  if (qrEl && typeof QRCode !== "undefined") {
    qrEl.innerHTML = "";
    new QRCode(qrEl, { text: payload, width: 180, height: 180 });
  } else if (qrEl) {
    qrEl.innerHTML = '<p style="color:#999;font-size:0.8rem;">QR Code não disponível.</p>';
  }

  // Botão copiar chave
  const copyBtn = document.getElementById(`copiarChavePix-${containerId}`);
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(chaveSemDDI)
        .then(() => {
          copyBtn.classList.add("copiado");
          copyBtn.innerHTML = '<i class="fas fa-check"></i> Copiado!';
          toast("Chave Pix copiada: " + chaveSemDDI, "#15803d");
          setTimeout(() => {
            copyBtn.classList.remove("copiado");
            copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copiar chave';
          }, 3000);
        })
        .catch(() => {
          toast("Erro ao copiar. Tente manualmente.", "#c0392b");
        });
    });
  }

  // Botão WhatsApp
  const whatsappLink =
    "https://wa.me/+5586994459953?text=" +
    encodeURIComponent(
      "Olá, confirmar  minha inscrição do evento Amadores de Bike. meu pix"
    );

  const waDiv = document.createElement("div");
  waDiv.style.marginTop = "12px";
  waDiv.style.textAlign = "center";
  waDiv.innerHTML = `
    <a href="${whatsappLink}" target="_blank" 
       class="btn btn-green" 
       style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: white;">
      <i class="fab fa-whatsapp"></i> enviar comprovante PIX
    </a>
  `;
  container.appendChild(waDiv);
};

// ---- EVENTOS e INICIALIZAÇÃO ----

// Inscrição
document.getElementById("btnGerarInscricao")?.addEventListener("click", async () => {
  if (!validarFormulario()) return;

  const dados = {
    nome: document.getElementById("nome").value.trim(),
    cidade: document.getElementById("cidade").value.trim(),
    equipe: document.getElementById("equipe").value.trim(),
    idade: parseInt(document.getElementById("idade").value, 10),
    genero: document.getElementById("genero").value,
  };

  const btn = document.getElementById("btnGerarInscricao");
  btn.innerHTML = '<span class="spinner"></span> Confirmando...';
  btn.disabled = true;

  try {
    const nova = await criarInscricaoGratuita(dados);
    await mostrarConfirmacao(nova);
    ["nome", "cidade", "equipe", "idade", "genero"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    toast("Inscrição  realizada! Código gerado.", "#2e7d32");
  } catch (err) {
    toast("Erro: " + err.message, "#c0392b");
  } finally {
    btn.innerHTML = '<i class="fas fa-ticket-alt"></i> Realizar inscrição ';
    btn.disabled = false;
  }
});

// Login Admin
document.getElementById("btnLoginAdmin")?.addEventListener("click", async () => {
  const errorMsg = document.getElementById("loginErrorMsg");
  if (errorMsg) errorMsg.classList.add("hidden");
  try {
    await signInWithEmailAndPassword(
      auth,
      document.getElementById("adminEmail").value.trim(),
      document.getElementById("adminPassword").value
    );
    document.getElementById("modalLogin").classList.add("hidden");
  } catch {
    if (errorMsg) errorMsg.classList.remove("hidden");
  }
});

// Estado de autenticação
onAuthStateChanged(auth, (user) => {
  if (user) {
    adminLogado = true;
    const tabAdminBtn = document.getElementById("tabAdminBtn");
    const adminLogoutContainer = document.getElementById("adminLogoutContainer");
    if (tabAdminBtn) tabAdminBtn.classList.remove("tab-hidden");
    if (adminLogoutContainer) adminLogoutContainer.style.display = "flex";
    if (document.getElementById("panel-admin")?.classList.contains("ativo"))
      carregarAdminUI();
  } else {
    adminLogado = false;
    const tabAdminBtn = document.getElementById("tabAdminBtn");
    const adminLogoutContainer = document.getElementById("adminLogoutContainer");
    if (tabAdminBtn) tabAdminBtn.classList.add("tab-hidden");
    if (adminLogoutContainer) adminLogoutContainer.style.display = "none";
    irParaTab("inscricao");
  }
});

document.getElementById("btnSairAdmin")?.addEventListener("click", () => signOut(auth));
document.getElementById("btnCancelarLogin")?.addEventListener("click", () => {
  document.getElementById("modalLogin").classList.add("hidden");
  const errorMsg = document.getElementById("loginErrorMsg");
  if (errorMsg) errorMsg.classList.add("hidden");
});

// Navegação por abas
document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab === "admin" && !adminLogado) {
      document.getElementById("modalLogin").classList.remove("hidden");
      return;
    }
    irParaTab(tab);
  });
});

// Clique secreto no logo
let clickCount = 0;
let timeoutAdmin;
document.getElementById("logoSecreto")?.addEventListener("click", () => {
  clickCount++;
  clearTimeout(timeoutAdmin);
  timeoutAdmin = setTimeout(() => (clickCount = 0), 800);
  if (clickCount >= 5) {
    clickCount = 0;
    if (adminLogado) irParaTab("admin");
    else document.getElementById("modalLogin").classList.remove("hidden");
  }
});

// Edição
document.getElementById("btnCancelEdit")?.addEventListener("click", () => {
  document.getElementById("modalEdit").classList.add("hidden");
});

document.getElementById("btnSaveEdit")?.addEventListener("click", async () => {
  const id = document.getElementById("editId").value;
  const novoNome = document.getElementById("editNome").value.trim();
  const novaEquipe = document.getElementById("editEquipe").value.trim();
  if (!novoNome) {
    toast("Nome não pode ficar vazio", "#c0392b");
    return;
  }
  try {
    await atualizarInscricao(id, novoNome, novaEquipe);
    toast("Dados atualizados!", "#15803d");
    document.getElementById("modalEdit").classList.add("hidden");
    carregarAdminUI();
  } catch {
    toast("Erro ao atualizar", "#c0392b");
  }
});

function irParaTab(tabId) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("ativo"));
  document.getElementById(`panel-${tabId}`)?.classList.add("ativo");
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove("active-inscricao", "active-confirmado", "active-admin");
  });
  document.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add(`active-${tabId}`);
  if (tabId === "admin" && adminLogado) carregarAdminUI();
}

// Inicialização
irParaTab("inscricao");
if (db) {
  window.addEventListener("load", () => migrarNumerosAntigos());
}
