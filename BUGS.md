# Bugs encontrados e correções

Registro de bugs reais encontrados durante o desenvolvimento (não é changelog de
features — só problemas e como foram resolvidos). Mantido atualizado a cada
sessão.

---

## 2026-09-01

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
