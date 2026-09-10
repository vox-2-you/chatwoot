# Quem pode embutir o Chatwoot num iframe.
#
# O Rails manda `X-Frame-Options: SAMEORIGIN` por padrão, e esse cabeçalho compara a origem
# inteira — protocolo, host e porta. Isso barra até um subdomínio irmão, então o CRM não
# consegue mostrar o painel numa tela sua.
#
# Com `FRAME_ANCESTORS` preenchida (origens separadas por vírgula), o cabeçalho antigo sai
# e entra um `frame-ancestors` de CSP, que aceita uma lista. Vazia, nada muda: a instância
# segue recusando qualquer iframe de fora.
#
# A sessão do atendente continua funcionando dentro do iframe quando as duas pontas ficam
# sob o mesmo domínio registrável, porque `SameSite` compara o domínio e ignora a porta.
frame_ancestors = ENV.fetch('FRAME_ANCESTORS', '').split(',').map(&:strip).reject(&:empty?)

if frame_ancestors.any?
  Rails.application.config.action_dispatch.default_headers.delete('X-Frame-Options')
  Rails.application.config.action_dispatch.default_headers['Content-Security-Policy'] =
    "frame-ancestors 'self' #{frame_ancestors.join(' ')}"
end
