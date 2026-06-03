# Usar uma imagem oficial do Node.js
FROM node:14

# Definir o diretório de trabalho dentro do contêiner
WORKDIR /var/lib/envioMassa_homologacao/app_homologacao

# Copiar os arquivos package.json e package-lock.json para o contêiner
COPY package*.json ./

# Instalar as dependências do projeto
RUN npm install

# Copiar todo o conteúdo do backend para dentro do contêiner
COPY . .

# Expor a porta 3000 (a porta do seu servidor)
EXPOSE 3000

# Rodar o comando para iniciar o servidor
CMD ["npm", "start"]
