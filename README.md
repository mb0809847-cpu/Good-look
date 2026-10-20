# Good Look

App de vídeos e shorts (vídeo, shorts, perfil e conversas), com contas de verdade
— o que uma pessoa publica aparece para as outras, em qualquer celular.

## Como funciona

- `index.html` — capa do app.
- `home.html` — criar conta / entrar. A conta vive no **servidor**.
- `app.html` — o app: feed, shorts, postar, live, PVB (chat público e privado),
  perfil e painel do criador.
- `sync.js` — a sincronia: o que muda neste aparelho sobe para o servidor e o que
  muda lá desce para cá (a cada 3 segundos, ou na hora quando você publica ou
  escreve). Sem servidor, o app continua funcionando só no aparelho.
- `server.js` — o servidor: entrega o site **e** guarda contas, vídeos, shorts,
  conversas e live. Sem dependências, só Node.

## Rodar

```bash
node server.js            # http://localhost:3000
PORT=8080 node server.js  # outra porta
```

Os dados ficam em `DATA_DIR` (por padrão `./data`): `db.json` com as contas,
vídeos e conversas, e `uploads/` com os arquivos enviados (vídeo da galeria,
foto de perfil, foto no chat). **Faça backup dessa pasta.**

## Colocar no ar (para funcionar entre celulares de verdade)

O app precisa de um lugar que rode o `server.js` (não serve hospedagem só de
arquivos estáticos, como o GitHub Pages: lá o app abre em modo local, sem ver as
outras pessoas). Qualquer host que rode Node ou Docker serve:

```bash
# com Docker (o Dockerfile já está na raiz do projeto)
docker build -t goodlook .
docker run -d -p 3000:3000 -v goodlook-data:/data goodlook
```

Depois é só abrir o endereço do host no celular e criar a conta. Todo mundo que
usar o mesmo endereço vê os mesmos vídeos, shorts, perfis e conversas.

## Contas

- A primeira conta do criador (`tex_tt`) é criada sozinha quando o servidor liga
  pela primeira vez.
- **A senha dela está no código.** Troque antes de usar de verdade: quem conhece
  essa senha entra como criador.
- Quem já tinha conta criada no aparelho (antes do servidor) entra normalmente:
  na primeira vez a conta é registrada no servidor com a mesma senha, e os vídeos
  que já estavam no aparelho sobem sozinhos.
