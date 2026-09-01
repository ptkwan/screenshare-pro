# Como lançar uma atualização

O app "ScreenShare Pro" tem auto-update embutido (`electron-updater`). Uma vez que
um amigo instalou a versão publicada, ele passa a receber as próximas atualizações
sozinho — não precisa mandar o instalador de novo.

Repositório de releases: https://github.com/ptkwan/screenshare-pro

## Toda vez que quiser lançar uma atualização

1. Suba o número da versão em `package.json` (campo `"version"`), seguindo
   [semver](https://semver.org/): `1.0.1` → `1.0.2` (correção pequena),
   `1.1.0` (funcionalidade nova), `2.0.0` (mudança grande).

   > O `electron-updater` só avisa os clientes se a nova versão for **maior**
   > que a que eles têm instalada. Esquecer de subir o número = ninguém recebe
   > a atualização.

2. No terminal, dentro da pasta `client`, gere o token do GitHub e rode o release:

   ```bash
   export GH_TOKEN=$(gh auth token)
   npm run release
   ```

   Isso builda o instalador (`.exe`) e publica automaticamente uma nova
   release no GitHub (`dist/` não precisa ser commitado — só o
   `electron-builder` usa essa pasta).

3. A release sobe como **draft** por padrão. Publique ela para os clientes
   passarem a enxergá-la:

   ```bash
   gh release edit vX.Y.Z --repo ptkwan/screenshare-pro --draft=false
   ```

   (troque `vX.Y.Z` pela versão que você acabou de lançar, ex: `v1.0.2`)

4. Pronto. Na próxima vez que cada amigo abrir o app, ele:
   - detecta a nova versão,
   - baixa em segundo plano,
   - instala sozinho assim que o app for fechado (não precisa fazer nada).

## Resumo rápido (copiar e colar)

```bash
cd client
# 1. edite "version" em package.json antes de rodar isso
export GH_TOKEN=$(gh auth token)
npm run release
gh release edit v$(node -p "require('./package.json').version") --repo ptkwan/screenshare-pro --draft=false
```

## Quando é preciso mandar o instalador manualmente de novo

Só na primeira instalação de cada pessoa (ou se alguém desinstalou o app).
O instalador fica em `dist/ScreenShare Pro Setup X.Y.Z.exe` depois do build,
ou disponível diretamente na página de releases:
https://github.com/ptkwan/screenshare-pro/releases/latest
