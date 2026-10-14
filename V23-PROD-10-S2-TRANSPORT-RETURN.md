# V23-PROD-10-S2 — retorno do transporte

Base do overlay: `3f81bbb78d5b5dbcb5018c3b51c1a321b9784b16`.
Análise exclusivamente estática; nenhum teste, parser, build, acesso operacional ou envio executado.

## Defeito demonstrado

`attendance-models.prisma` declara `transportReturn Json?`. Em
`nexi-attendance-authority.cjs::transportReturned`, o filtro de `updateMany`
usava `transportReturn: null`. JSON anulável exige um filtro JSON; `null`
simples não é um `JsonNullableFilter` válido no Prisma 7.8.0 fixado pelo
lockfile do upstream `e273b904d53f5726970fd6a244ed9caa61dfeb9a`.

O contrato foi lido, sem executar cliente/gerador, no material local já
existente `../qr-anchor-build/prisma/generated/client/commonInputTypes.ts`
(`JsonNullableFilter` / `JsonNullableFilterBase`) e
`models/Webhook.ts` (outro campo `Json?`). A versão desse cliente consta em
`internal/prismaNamespace.ts`; o lockfile foi confrontado com o checkout
`../evolution-reference` no SHA upstream fixado. Esse material é evidência
do contrato da dependência, não de qual imagem estava executando na OVH.

Depois do CAS, `dispatch` aguarda `sendMessage`, verifica a identidade retornada
e chama `transportReturned(..., true)`. Uma exceção nesse caminho entra no
`catch`, que, havendo `dispatchStartedAt`, chama `transportReturned(..., false)`.
Ambas as chamadas tinham o mesmo filtro inválido. A segunda exceção chega ao
handler de authority, que responde 422 genérico sem registrar a causa.
Assim, o defeito permite envio físico seguido de ausência permanente de retorno
persistido. Não se atribui uma exceção operacional específica aos três envios
sem comprovar a equivalência do artefato implantado com o overlay examinado.

## Patch mínimo

Removido apenas o predicado JSON redundante. Permanecem:

- transação e `storageGuard`;
- exigência de dispatch anterior e do mesmo `consumptionId`;
- retorno antecipado se já existe `transportReturn`;
- CAS por `id`, `revision` e `state: dispatch_started`;
- incremento de revisão, proteção write-once do banco e `outcomeUnknown: true`.

Dois escritores de retorno que leem a mesma revisão não podem vencer juntos.
O vencedor muda a revisão e sai de `dispatch_started`. Não se importam enums de
um cliente gerado nem se adiciona SQL específico de PostgreSQL/MySQL.
Não há alteração de schema, grants, socket, receipts ou callback APP.

## Limite da correção

`transportReturn` registra conclusão/erro do método de transporte, nunca ACK,
entrega ou leitura. O CAS ocorre em `assertNode`, antes de logging, codificação,
`sendRawMessage`, Noise e `ws.send`. Exceção, perda de processo ou falha de banco
nesse intervalo mantém incerteza. O patch não recupera retrospectivamente um
retorno que nunca foi persistido e não permite repetir o envio após CAS.

Receipts continuam independentes: `handleReceipt.pre_buffer` / bad ACK com erro
→ captura → journal + outbox na mesma transação → callback HMAC → APP.
Não foi demonstrada a causa operacional de sua ausência para Messages 769–771.
Revisão independente deve avaliar o CAS e o contrato JSON; nenhuma validação
executável foi feita nesta missão. Sem deploy, promoção, push ou reprocessamento.
