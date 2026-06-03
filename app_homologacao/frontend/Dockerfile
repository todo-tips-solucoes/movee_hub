# Usar uma imagem oficial do Nginx para servir os arquivos estáticos
FROM nginx:alpine

# Copiar os arquivos do frontend para o diretório padrão do Nginx
COPY . /usr/share/nginx/html

# Expor a porta 80 (onde o Nginx vai rodar)
EXPOSE 80

# O Nginx será executado automaticamente quando o contêiner iniciar
