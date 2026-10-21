# Backup consistente e restauração

O banco SQLite contém dados privados de cadastro e autenticação e pode conter operações, endereços, histórico e amostras de localização compartilhadas na aplicação principal. Backups também são privados. Guarde-os fora do repositório e de qualquer diretório servido por HTTP, com permissões restritivas, retenção definida e proteção adequada no armazenamento. Nunca publique um backup no GitHub.

## Criar e verificar

Configure `DATABASE_PATH` para o banco local correto e escolha um **arquivo de destino novo**, fora do checkout público:

```powershell
npm run db:backup -- "C:\caminho-privado\titoja-backup.sqlite"
```

No Linux, use um caminho absoluto próprio, por exemplo um arquivo novo dentro do diretório privado de backups aprovado. O comando não sobrescreve um arquivo existente. Só considere o backup concluído quando o processo terminar sem erro e a verificação de integridade passar.

O utilitário usa a API de backup de `node:sqlite`, abrindo a origem para leitura, e verifica o resultado. Isso produz uma cópia consistente mesmo quando o banco usa WAL. Não copie apenas `titoja.sqlite` enquanto a aplicação está gravando: alterações confirmadas podem estar no arquivo `-wal`.

O comando não migra dados para outro serviço, não envia arquivos e não cria uma rotina automática. Definir local, retenção, agendamento, proteção em repouso e teste periódico de restauração é responsabilidade da futura instalação.

## Antes de restaurar

Teste primeiro em um diretório e banco temporários, sem substituir o arquivo ativo. Confira integridade, schema/migrations e compatibilidade do release que usará essa cópia. Testes com dados de produção precisam permanecer privados.

Um backup representa um instante: registros novos e revogações posteriores à cópia não estarão nele. Uma restauração também pode trazer de volta registros de sessão daquele instante. Antes de reabrir o serviço restaurado, invalide as sessões restauradas pelo procedimento de manutenção do banco; os usuários precisarão entrar novamente. Não trate um restore como mecanismo de recuperação individual de senha.

## Restauração offline planejada

1. Planejar uma janela de manutenção e parar **somente o serviço próprio do TitoJá**. Não interromper nginx, PM2 ou outras aplicações para restaurar esse arquivo.
2. Confirmar que nenhum processo está conectado ao arquivo de destino. Preservar uma cópia de recuperação do estado atual, incluindo os arquivos auxiliares que ainda existirem.
3. Validar o backup antes de substituir qualquer arquivo. Não executar comandos com um caminho de banco vazio, relativo ambíguo ou pertencente a outro projeto.
4. Restaurar a cópia verificada no caminho `DATABASE_PATH`, com o proprietário e as permissões do usuário de serviço. Não associar um `-wal` ou `-shm` antigo ao banco restaurado; tratar os arquivos antigos como parte do estado preservado, com o serviço parado.
5. Invalidar as sessões restauradas e verificar as chaves estrangeiras e as migrations com o release compatível. Não apagar ou reaplicar migrations indiscriminadamente.
6. Iniciar somente o serviço próprio e testar login, isolamento de perfis e leitura do cadastro com contas de teste autorizadas. Conferir os logs sem exibir dados privados.

A restauração não é executada automaticamente por este repositório. Substituir um banco real é uma ação administrativa própria e deve usar caminhos conferidos, backup de recuperação e aprovação da manutenção.
