# Bugs encontrados e correções

Registro de bugs reais encontrados durante o desenvolvimento (não é changelog de
features — só problemas e como foram resolvidos). Mantido atualizado a cada
sessão.

---

## 2026-09-02

### Tela de conexão travava o pedido de lista de salas (referência a botão removido)
- **Sintoma**: ao remover a tela de "entrada rápida" (parte da mudança pra
  sempre mostrar a lista de salas), o app parava de pedir a lista de salas
  ativas ao conectar -- a lista só aparecia depois de algum evento
  incidental (entrar/sair de sala em outro cliente), nunca no primeiro
  carregamento.
- **Causa**: sobrou uma linha (`document.getElementById('btn-quick-join').disabled
  = false`) referenciando um botão que eu tinha acabado de apagar do HTML
  como parte da mesma mudança. `getElementById` de um id inexistente
  retorna `null`, e `null.disabled = false` lança uma exceção -- que
  interrompia o resto do handler `socket.on('connect', ...)`, incluindo o
  `socket.emit('get-rooms')` logo depois.
- **Correção**: removida a linha órfã.
- **Como foi encontrado**: teste automatizado com dois clientes reais --
  o segundo cliente nunca via nenhuma sala na lista ao conectar, mesmo
  com salas ativas.

### Botão de ocultar/mostrar participantes não reabria em janela estreita
- **Sintoma**: achado durante o teste do redesign, mas é um bug pré-existente
  (não introduzido pelo redesign): abaixo de 768px de largura, o painel de
  participantes some sozinho (classes `hidden md:flex`). Clicar no botão de
  toggle pra reabrir não tinha efeito nenhum nessa largura.
- **Causa**: o botão só alternava as classes `hidden`/`md:flex`, e `md:flex`
  simplesmente não se aplica abaixo de 768px — não tinha nenhum jeito de
  forçar visível numa janela estreita.
- **Correção**: o toggle agora decide pelo que está *realmente* visível na
  tela (`offsetParent !== null`) em vez de só uma preferência salva, e força
  a visibilidade via `style.display` direto (que vence a regra responsiva)
  quando o clique é explícito. Mesmo tratamento dado ao novo toggle da
  sidebar de canais.
- **Validado** com teste automatizado em 700px: escondido por padrão, primeiro
  clique mostra, segundo esconde — e confirmado que o comportamento em
  largura padrão (1280px) continua correto nos dois sentidos.

### Não existia jeito de sair de uma sala / trocar de servidor sem fechar o app
- **Sintoma**: reportado pelo Patrick com print — depois de entrar numa sala
  (nesse caso uma sala com nome quebrado, "[object Object]" — ver bug
  seguinte), não tinha nenhum botão ou ação pra voltar ao seletor de salas.
  Único jeito era fechar o app inteiro e abrir de novo.
- **Causa**: o botão "Trocar de sala" só existe na tela de login
  (`#connection-modal`), antes de entrar numa sala. O servidor também nunca
  teve um evento pra "sair da sala sem desconectar" — só existia limpeza
  automática no `disconnect` (queda de conexão de verdade).
- **Correção**: novo botão "Sair da sala" (`#btn-leave-room`) do lado do
  nome da sala na sidebar, visível pra qualquer participante (não só o
  dono). Emite um novo evento `leave-room` que o servidor trata sem
  desconectar o socket — extraído num helper `removeFromRoom()`
  compartilhado com o `disconnect` (mesma limpeza, sem duplicar código).
  Depois de sair, o cliente volta pro seletor de salas e pode entrar em
  outra sala normalmente na mesma sessão do app.
- **Validado** com teste automatizado: A cria sala X, B entra em X (via fila
  de aprovação), B clica em "Sair da sala", A vê a contagem de participantes
  cair corretamente, e B consegue entrar numa sala Y diferente sem fechar o
  app.

### Nome de sala virava "[object Object]" e ficava permanente
- **Sintoma**: o Patrick ficou preso numa sala literalmente chamada
  "[object Object]" (confirmado inspecionando o `localStorage` real do app
  — `ssp-last-room` tinha esse valor salvo).
- **Causa**: `roomId` nunca passava por nenhuma limpeza/validação no
  servidor (`join-room`) — qualquer string virava o nome literal e
  permanente da sala (a Map key), incluindo texto colado/digitado por
  engano. Combinado com o bug anterior (sem jeito de sair), quem caísse
  numa sala com nome ruim ficava preso lá.
- **Correção**: `roomId` agora passa por `cleanName()` (mesma limpeza já
  usada pro nome de usuário) antes de qualquer coisa em `join-room`, e um
  nome vazio depois de limpo rejeita a entrada (`join-error` com motivo
  `invalid-room-name`) em vez de criar uma sala sem nome. Não impede
  alguém de digitar um nome esquisito de propósito (não dá pra saber a
  intenção), mas combinado com o botão de sair, deixa de ser uma
  armadilha sem saída.
- **Validado** com teste automatizado: nome de sala em branco não entra em
  lugar nenhum, permanece no seletor.

### CSP bloqueava silenciosamente o AudioWorklet (quebrava a captura de áudio nativa por app desde a v1.8.0)
- **Sintoma**: ao testar a captura de áudio nativa (tanto a versão nova de
  "Tela Cheia" quanto a versão por app que já estava em produção),
  `nativeAudioCtx.audioWorklet.addModule(blobUrl)` rejeitava com
  `DOMException: The user aborted a request` — mensagem genérica que não
  aponta pra causa real.
- **Causa**: o Content-Security-Policy adicionado na v1.8.0 (`script-src
  'self' 'unsafe-inline'`, sem `blob:`, e sem `worker-src` nenhum) bloqueia
  o carregamento do módulo do AudioWorklet a partir de uma `blob:` URL — e
  o Chromium reporta esse bloqueio como um erro genérico de "abort" em vez
  de um erro de CSP explícito, o que escondeu a causa real. Como esse
  código é compartilhado entre a captura por app (já em produção desde a
  v1.5.0) e a nova captura de tela cheia, **a captura de áudio por app
  provavelmente já estava quebrada silenciosamente desde a v1.8.0** sem
  ninguém perceber (o fallback pro modo antigo escondia o problema).
- **Correção**: `script-src` ganhou `blob:` e foi adicionado `worker-src
  'self' blob:` no CSP (`index.html`).
- **Como foi encontrado**: testando a nova captura de tela cheia com
  Playwright pilotando duas instâncias reais do Electron (dono + convidado)
  contra um servidor local — sem isso, o erro genérico de "abort" seria
  fácil de atribuir à lib nativa em vez do CSP.

## 2026-09-01

### Script `.ps1` de resolução de PID quebrava só no build empacotado (não em dev)
- **Sintoma**: a captura de áudio por aplicativo (que resolve o PID de uma
  janela via PowerShell) funcionava perfeitamente em modo dev, mas quebraria
  silenciosamente no instalador final.
- **Causa**: o script `native/resolve-window-pid.ps1` era referenciado via
  `path.join(__dirname, 'native', ...)`. Em modo dev isso aponta pra um
  arquivo real no disco. No app empacotado, `__dirname` fica dentro do
  `app.asar` (um arquivo único, não uma pasta de verdade) — e o PowerShell é
  um processo *externo* que não entende esse sistema de arquivos virtual do
  Electron, só arquivos reais no disco.
- **Correção**: adicionado `native/**/*` no `asarUnpack` do `package.json`
  (igual já era feito pro módulo nativo `loopback-capture`), e o caminho do
  script em `main.js` passou a apontar pra `resources/app.asar.unpacked/...`
  quando `app.isPackaged` é verdadeiro.
- **Como foi encontrado**: rodando o build empacotado de verdade (`electron-builder --dir`)
  antes de lançar, em vez de confiar só no teste em modo dev — esse tipo de
  bug de empacotamento nunca aparece rodando `npm start`.

### Correção do "auto-mudo" ao compartilhar áudio do sistema era fácil de desfazer sem querer
- **Sintoma**: mesmo depois da correção que muta automaticamente quem
  compartilha "Áudio do Sistema", o eco continuava acontecendo às vezes. Só
  parava quando a pessoa compartilhando silenciava manualmente o outro
  participante especificamente (mute individual).
- **Causa**: o "auto-mudo" só define o estado inicial (`isMuted = true`) no
  momento em que o compartilhamento começa, mas o botão de volume/slider
  continuavam clicáveis normalmente. Quem está compartilhando, querendo
  ouvir a pessoa falando durante a call, clica no botão de volume pra
  reativar o áudio — e sem perceber, desfaz a proteção e o eco volta.
- **Correção**: o botão de volume e o slider ficam **travados** (visual e
  funcionalmente — clique/arraste não fazem nada, inclusive clique
  disparado por código) enquanto o "Áudio do Sistema" estiver ligado.
  Só destrava ao parar de compartilhar. É um trade-off consciente: não dá
  pra ouvir os outros enquanto compartilha áudio do sistema, mas isso é
  necessário pra não vazar eco pra quem assiste.
- **Validado**: teste automatizado tentando reativar o áudio por clique
  normal e por clique disparado via código durante o compartilhamento —
  confirmado que o estado mudo se mantém nos dois casos, e destrava
  corretamente ao parar de compartilhar.

### Eco/vozes duplicadas ao trocar de canal de voz (vazamento de áudio no Web Audio)
- **Sintoma**: depois de usar o app um tempo (trocando de sala de voz, ou de
  sala/servidor), quem estava ouvindo passava a escutar a própria voz de
  volta, ou vozes sobrepostas — "eco"/"retorno" constante, piorando com o
  tempo de uso.
- **Causa**: quando o chat de voz passou a usar Web Audio API (GainNode) pra
  permitir volume de 0-200% por pessoa, as funções que fecham TODAS as
  conexões de voz de uma vez (entrar/sair de canal de voz, trocar de sala,
  voltar ao lobby) fechavam a `RTCPeerConnection` e apagavam os elementos
  `<audio>` do HTML, mas nunca chamavam `.disconnect()` nos `GainNode`
  correspondentes. Nó de Web Audio conectado ao destino continua tocando
  pra sempre mesmo sem nenhuma referência JS apontando pra ele — cada troca
  de canal deixava um nó "fantasma" tocando por cima dos novos, empilhando
  áudio duplicado (incluindo a própria voz de quem ouve, já que ela também
  passa pela malha de voz).
- **Correção**: criada `closeAllVoicePeers()`, usada nos 4 lugares que
  fechavam conexões de voz em lote — ela passa cada peer por
  `removeVoiceAudio()` (que já desconectava o GainNode corretamente no
  caso de desconexão individual) em vez de só limpar o HTML.
- **Validado**: teste automatizado trocando de canal de voz 3x seguidas
  entre duas instâncias — antes da correção o número de GainNodes ativos
  cresceria a cada troca; depois da correção fica sempre em 1 (só a conexão
  atual).

### Eco / vozes duplicadas ao compartilhar "Áudio do Sistema"
- **Sintoma**: quem assistia a tela de alguém compartilhando com "Áudio do
  Sistema" ligado ouvia a própria voz de volta (eco), ou ouvia as vozes do
  chat de voz em dobro.
- **Causa**: a captura de "Áudio do Sistema" no Windows pega literalmente
  tudo que está tocando no PC de quem compartilha — inclusive o que essa
  pessoa está ouvindo pelo chat de voz. Isso volta pra rede junto com o
  compartilhamento de tela.
- **Correção**: ao ligar "Áudio do Sistema", o app agora silencia
  automaticamente (só do lado de quem compartilha) o que essa pessoa ouve dos
  outros, restaurando o estado anterior ao parar de compartilhar. O
  microfone dela continua saindo normalmente.

### Tela preta ao assistir alguém que também está te assistindo
- **Sintoma**: quando duas pessoas compartilhavam tela e assistiam uma à
  outra ao mesmo tempo, uma das duas ficava com a tela do outro preta.
- **Causa**: `handleCandidate` escolhia entre `viewerPeers` e `senderPeers`
  só pelo id de quem mandou o candidato ICE (`viewerPeers[id] ||
  senderPeers[id]`). Quando as duas conexões existiam ao mesmo tempo pro
  mesmo par de pessoas, os candidatos de uma conexão podiam ser aplicados na
  conexão errada, quebrando a negociação ICE de um dos dois lados.
- **Correção**: cada candidato ICE de compartilhamento de tela agora carrega
  um rótulo (`screen-broadcast` / `screen-view`) que identifica sem
  ambiguidade a qual conexão ele pertence — o mesmo padrão já usado pro chat
  de voz (`kind: 'voice'`).
- **Validado**: teste automatizado com duas instâncias compartilhando e
  assistindo uma à outra simultaneamente.

### Botão de "editar meu nome" não fazia nada
- **Sintoma**: clicar no lápis pra mudar o próprio nome na lista de
  participantes não abria o popup de renomear.
- **Causa**: o `onclick="window.startEditOwnName()"` não passava o evento de
  clique pra função, que precisa dele (`e.stopPropagation()` e
  `e.clientX/clientY` pra posicionar o popup) — chamando sem argumento,
  `e` ficava `undefined` e a função quebrava silenciosamente (o erro
  acontece dentro do handler inline do HTML, que não aparece no console
  principal do app).
- **Correção**: `onclick="window.startEditOwnName(event)"`.
- **Como foi encontrado**: teste automatizado clicando no botão e conferindo
  se o próprio nome realmente mudava na lista — sem esse teste, o bug
  passaria despercebido numa checagem visual rápida.

## Limitações conhecidas (não são bugs do app)

### "Tela cheia" é a única opção pra quem está com um jogo em modo exclusivo
Quando um jogo roda em "Tela Cheia" (exclusiva, não "sem bordas"), o Windows
desliga o compositor de janelas (DWM) pra esse app ter controle total da
tela. Nesse modo, `desktopCapturer.getSources({types:['window','screen']})`
não consegue gerar miniatura de nenhuma janela, só da tela toda — afeta
qualquer programa de captura (OBS, Discord, etc), não é específico desse
app. Solução: usar "Tela Cheia sem Bordas" / "Janela sem Borda" nas opções
gráficas do jogo.

### Sem servidor TURN, só STUN
O app usa só `stun:stun.l.google.com:19302`. Isso cobre a maioria das redes,
mas pode falhar em conectar entre pessoas atrás de NAT muito restritivo
(redes corporativas/universitárias, alguns roteadores 4G). Se algum dia
duas pessoas específicas nunca conseguirem se conectar, esse costuma ser o
motivo — a solução é configurar um servidor TURN, mas não é urgente hoje.
