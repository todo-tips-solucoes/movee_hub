const backendUrl = 'https://envmassapihomologacao.todo-tips.com'; // URL do backend

document.addEventListener('DOMContentLoaded', function () {
    const loginSection = document.getElementById('login-section');
    const registerSection = document.getElementById('register-section');
    const crudSection = document.getElementById('crud-section');
    let nomeEmpresa = null; // Variável para armazenar o nome da empresa obtido do backend
    let data = []; // Variável para armazenar os dados
    let currentPage = 1; // Página atual
    let recordsPerPage = 100; // Quantidade de registros por página
    let filteredData = [];
    let stopProcess = false;
    let tableUpdateInterval;

    // Inicializa o Datepicker para o campo de Data Emissão
    $('#filterDataEmissao').datepicker({
        dateFormat: 'dd/mm/yy', // Formato da data
        onSelect: function () {
            applyFilters(); // Reaplica os filtros quando uma data for selecionada
        }
    });

    // Mostrar tela de cadastro
    document.getElementById('showRegister').addEventListener('click', function () {
        loginSection.classList.add('d-none');
        registerSection.classList.remove('d-none');
    });

    // Mostrar tela de login
    document.getElementById('showLogin').addEventListener('click', function () {
        registerSection.classList.add('d-none');
        loginSection.classList.remove('d-none');
    });

    // Função para verificar se o usuário já está logado
    function checkAuth() {
        fetch(`${backendUrl}/verify-auth`, { 
            method: 'GET', 
            credentials: 'include'  // Para garantir que os cookies sejam enviados
        })
        .then(response => response.json())
        .then(data => {
            if (data.authenticated) {
                nomeEmpresa = data.nome_empresa;
                loadNomeEmpresa(nomeEmpresa);
                crudSection.classList.remove('d-none');
                loginSection.classList.add('d-none');
                loadEnvioMassaTable();
            } else {
                loginSection.classList.remove('d-none');
                crudSection.classList.add('d-none');
            }
        })
        .catch(err => {
            console.error("Erro ao verificar autenticação: ", err);
            loginSection.classList.remove('d-none');
        });
    }

    // Verifica a autenticação ao carregar a página
    checkAuth();

    // Função para carregar o nome da empresa após o login
    async function loadNomeEmpresa(nodeNomeEmpresa) {
        const lblNomeEmpresa = document.getElementById('lblNomeEmpresa');
        lblNomeEmpresa.innerHTML = ''; // Limpa a tabela antes de preencher
        lblNomeEmpresa.innerHTML = `${nodeNomeEmpresa}`;
    }

    // Lógica de Cadastro
    document.getElementById('registerForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const nomeEmpresa = document.getElementById('nomeEmpresa').value;
        const email = document.getElementById('emailCadastro').value;
        const senha = document.getElementById('senhaCadastro').value;
        const confirmSenha = document.getElementById('confirmSenhaCadastro').value;

        if (senha !== confirmSenha) {
            alert('As senhas não conferem.');
            return;
        }

        const response = await fetch(`${backendUrl}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ nomeEmpresa, email, senha }),
            credentials: 'include' // Necessário para enviar cookies de autenticação
        });

        const result = await response.json();

        if (response.ok) {
            alert('Cadastro realizado com sucesso! Faça login para continuar.');
            registerSection.classList.add('d-none');
            loginSection.classList.remove('d-none');
        } else {
            alert('Erro ao realizar cadastro: ' + result.error);
        }
    });

    // Lógica de Login
    document.getElementById('loginForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const email = document.getElementById('emailLogin').value;
        const password = document.getElementById('passwordLogin').value;

        // Mostra a animação de carregamento
        document.getElementById('loadingAnimation').classList.remove('d-none');

        const response = await fetch(`${backendUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
            credentials: 'include' // Envia os cookies automaticamente
        });

        const result = await response.json();

        if (response.ok) {
            nomeEmpresa = result.nome_empresa;
            loadNomeEmpresa(nomeEmpresa);
            loginSection.classList.add('d-none');
            crudSection.classList.remove('d-none');
            loadEnvioMassaTable(); // Chama função para carregar o CRUD
            document.getElementById('loadingAnimation').classList.add('d-none');
            document.getElementById('emailLogin').value = '';
            document.getElementById('passwordLogin').value = '';
        } else {
            alert('Erro ao realizar login: ' + result.error);
            document.getElementById('loadingAnimation').classList.add('d-none');
            document.getElementById('emailLogin').value = '';
            document.getElementById('passwordLogin').value = '';
        }
    });

    // Lógica de Logout
    document.getElementById('logoutBtn').addEventListener('click', async function () {
        const response = await fetch(`${backendUrl}/logout`, {
            method: 'POST',
            credentials: 'include' // Necessário para enviar cookies de autenticação
        });

        if (response.ok) {
            loginSection.classList.remove('d-none');
            crudSection.classList.add('d-none');
            alert('Logout realizado com sucesso!');
        } else {
            alert('Erro ao realizar o logout');
        }
    });

    // Função para verificar e renovar token automaticamente
    async function renewToken() {
        try {
            const response = await fetch(`${backendUrl}/token/refresh`, {
                method: 'POST',
                credentials: 'include'
            });
            if (!response.ok) {
                // Token de atualização falhou, redireciona para login
                window.location.reload();
            }
        } catch (error) {
            window.location.reload();
        }
    }

    // Verificar e renovar o token de tempos em tempos (por exemplo, a cada 10 minutos)
    setInterval(renewToken, 10 * 60 * 1000); // A cada 10 minutos

    // Função para carregar a tabela de EnvioMassa após o login
    async function loadEnvioMassaTable() {
        const response = await fetch(`${backendUrl}/envio-massa/`, {
            credentials: 'include' // Inclui os cookies de autenticação
        });
        const result = await response.json();

        if (!response.ok) {
            console.log('Erro ao carregar a tabela de envios: ' + result.error);
            return;
        }

        data = result; // Salva os dados obtidos
        filteredData = data; // Inicializa os dados filtrados com todos os dados
        displayTableWithPagination(); // Exibe os dados na tabela com paginação
        updateCounts(); // Atualiza as contagens
    }

    // Função para exibir a tabela com paginação
    function displayTableWithPagination() {
        const tableBody = document.getElementById('envioMassaTable');
        tableBody.innerHTML = ''; // Limpa a tabela antes de preencher

        const start = (currentPage - 1) * recordsPerPage;
        const end = recordsPerPage === 'all' ? filteredData.length : start + recordsPerPage;
        const paginatedData = filteredData.slice(start, end);

        paginatedData.forEach(item => {
            retorno_envio_msg_1 = item.retorno_envio_msg_1 === null ? '' : item.retorno_envio_msg_1;
            retorno_envio_msg_2 = item.retorno_envio_msg_2 === null ? '' : item.retorno_envio_msg_2;
            const enviado = (item.enviado === 'ok' || item.enviado === 'erro') ? 'checked' : '';
            const sucesso = (item.enviado === 'erro') ? 'checked' : '';
            const erro_validacao = item.erro_validacao === null ? '' : item.erro_validacao;
            const validacao = ( erro_validacao !== '') ? 'checked' : '';
            const xmlLink = item.nota_ok ? `<a href="${item.nota_ok}" target="_blank">Ver XML</a>` : '';

            // Formatação do valor em R$ #.##0,00
            const valorFormatado = parseFloat(item.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

            const tableRow = document.createElement('tr');
            tableRow.innerHTML = `
                <td><input id="selecao" type="checkbox"></td>
                <td>${item.number}</td>
                <td>${item.nome}</td>
                <td>${valorFormatado}</td>
                <td><input id="naoselecao" type="checkbox" ${enviado ? 'checked' : ''}></td>
                <td><input id="naoselecao" type="checkbox" ${sucesso ? 'checked' : ''}></td>
                <td>${item.numnota === null ? '' : item.numnota}</td>
                <td>${xmlLink}</td>
                <td>${new Date(item.data_emissao).toLocaleDateString('pt-BR') === '31/12/1969' ? '' : new Date(item.data_emissao).toLocaleDateString('pt-BR')}</td>
                <td data-toggle="tooltip" data-placement="left" title="${item.erro_validacao ? item.erro_validacao : 'Sem erro'}"><input id="naoselecao" type="checkbox" ${validacao ? 'checked' : ''}></td>
                <td class="actions">
                    <button class="btn btn-sm btn-warning" onclick="editRow(${item.id})" disabled><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-danger" onclick="deleteRow(${item.id})" disabled><i class="fas fa-trash"></i></button>
                </td>
            `;
            tableBody.appendChild(tableRow);
        });

        updatePaginationControls();
    }

    // Função para atualizar os controles de paginação
    function updatePaginationControls() {
        const paginationControls = document.getElementById('paginationControls');
        paginationControls.innerHTML = ''; // Limpa os controles antes de preencher

        const totalPages = Math.ceil(filteredData.length / recordsPerPage);

        // Botão "Anterior"
        const prevLi = document.createElement('li');
        prevLi.classList.add('page-item');
        prevLi.innerHTML = `<a class="page-link" href="#">Anterior</a>`;
        prevLi.onclick = () => {
            if (currentPage > 1) {
                currentPage--;
                displayTableWithPagination();
            }
        };
        paginationControls.appendChild(prevLi);

        // Páginas
        for (let i = 1; i <= totalPages; i++) {
            const li = document.createElement('li');
            li.classList.add('page-item');
            li.innerHTML = `<a class="page-link" href="#">${i}</a>`;
            if (i === currentPage) li.classList.add('active');
            li.onclick = () => {
                currentPage = i;
                displayTableWithPagination();
            };
            paginationControls.appendChild(li);
        }

        // Botão "Próximo"
        const nextLi = document.createElement('li');
        nextLi.classList.add('page-item');
        nextLi.innerHTML = `<a class="page-link" href="#">Próximo</a>`;
        nextLi.onclick = () => {
            if (currentPage < totalPages) {
                currentPage++;
                displayTableWithPagination();
            }
        };
        paginationControls.appendChild(nextLi);
    }

    // Função para deletar um registro
    async function deleteRow(id) {
        if (confirm('Tem certeza que deseja excluir este registro?')) {
            const response = await fetch(`${backendUrl}/envio-massa/${id}`, {
                method: 'DELETE',
                credentials: 'include' // Necessário para enviar cookies de autenticação
            });

            if (response.ok) {
                loadEnvioMassaTable(); // Recarrega a tabela após a exclusão
            } else {
                alert('Erro ao excluir o registro.');
            }
        }
    }

    // Função para aplicar filtros
    function applyFilters() {
        const numeroFilter = document.getElementById('filterNumero').value.toLowerCase();
        const nomeFilter = document.getElementById('filterNome').value.toLowerCase();
        const valorFilter = document.getElementById('filterValor').value.toLowerCase();
        const enviadoFilter = document.getElementById('filterEnviado').checked;
        const sucessoFilter = document.getElementById('filterSucesso').checked;
        const numNotaFilter = document.getElementById('filterNumNota').value.toLowerCase();
        const dataEmissaoFilter = document.getElementById('filterDataEmissao').value.toLowerCase(); // Adiciona o filtro de data
        const validacaoFilter = document.getElementById('filterValidacao').checked;

        filteredData = data.filter(item => {
            const numero = item.number === null ? '' : item.number.toLowerCase();
            const nome = item.nome.toLowerCase();
            const valor = item.valor === null ? '' : item.valor.toString();
            const enviado = (item.enviado === 'ok' || item.enviado === 'erro');
            const sucesso = item.enviado === 'erro';
            const numNota = item.numnota ? item.numnota.toString().toLowerCase() : '';
            const dataEmissao = item.data_emissao ? new Date(item.data_emissao).toLocaleDateString('pt-BR').toLowerCase() : '';
            const erro_validacao = item.erro_validacao === null ? '' : item.erro_validacao;
            const validacao = erro_validacao !== '';

            return (
                numero.includes(numeroFilter) &&
                nome.includes(nomeFilter) &&
                valor.includes(valorFilter) &&
                (!enviadoFilter || enviado) &&
                (!sucessoFilter || sucesso) &&
                numNota.includes(numNotaFilter) &&
                dataEmissao.includes(dataEmissaoFilter) && // Aplica o filtro de data
                (!validacaoFilter || validacao)
            );
        });

        currentPage = 1; // Reinicia para a primeira página após aplicar os filtros
        displayTableWithPagination();
    }

    // Função para mudar a quantidade de registros por página
    document.getElementById('recordsPerPage').addEventListener('change', function () {
        recordsPerPage = this.value === 'all' ? filteredData.length : parseInt(this.value);
        currentPage = 1; // Reinicia para a primeira página
        displayTableWithPagination();
    });

    // Adicionar eventos de input para aplicar os filtros
    document.getElementById('filterNumero').addEventListener('input', applyFilters);
    document.getElementById('filterNome').addEventListener('input', applyFilters);
    document.getElementById('filterValor').addEventListener('input', applyFilters);
    document.getElementById('filterEnviado').addEventListener('change', applyFilters);
    document.getElementById('filterSucesso').addEventListener('change', applyFilters);
    document.getElementById('filterNumNota').addEventListener('input', applyFilters);
    document.getElementById('filterDataEmissao').addEventListener('input', applyFilters);
    document.getElementById('filterValidacao').addEventListener('change', applyFilters);

    // Função para selecionar ou desmarcar todos os registros
    document.getElementById('filterSelected').addEventListener('change', function () {
        const isChecked = this.checked;
        const checkboxes = document.querySelectorAll('#envioMassaTable input[type="checkbox"][id="selecao"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = isChecked;
        });
    });

    // Função para editar um registro (a ser implementada)
    function editRow(id) {
        alert('Editar registro: ' + id);
        // Aqui você pode adicionar a lógica para abrir um formulário de edição
    }

    // Função para exportar arquivo CSV
    document.getElementById('exportFile').addEventListener('click', function () {
        document.getElementById('loadingAnimation').classList.remove('d-none');

        fetch(`${backendUrl}/export-envio-massa`, {
            method: 'GET',
            credentials: 'include', // Incluir cookies de autenticação
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Erro ao exportar CSV');
            }
            return response.blob();
        })
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'envio_massa.csv'; // Nome do arquivo
            document.body.appendChild(a);
            a.click();
            a.remove();
        })
        .catch(error => {
            alert('Erro ao exportar CSV: ' + error.message);
        })
        .finally(() => {
            document.getElementById('loadingAnimation').classList.add('d-none');
        });
    });

    // Função para baixar XMLs do movimento em aberto
    document.getElementById('downloadXmlMov').addEventListener('click', function () {
      document.getElementById('loadingAnimation').classList.remove('d-none');

      fetch(`${backendUrl}/download-xml-movimento`, {
        method: 'GET',
        credentials: 'include', // importante para enviar cookies com o JWT
      })
        .then(response => {
          if (!response.ok) {
            throw new Error('Erro ao baixar XMLs (status ' + response.status + ')');
          }
          return response.blob();
        })
        .then(blob => {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'xml_movimento_aberto.zip'; // nome padrão no cliente
          document.body.appendChild(a);
          a.click();
          a.remove();
        })
        .catch(error => {
          alert('Erro ao baixar XMLs: ' + error.message);
        })
        .finally(() => {
          document.getElementById('loadingAnimation').classList.add('d-none');
        });
    });


    // Função para fechar o movimento
    document.getElementById('closeMov').addEventListener('click', async function () {
        const confirmClose = confirm('Você realmente deseja fechar o movimento? Se fechar o movimento, não poderá mais ter acesso ao mesmo.');
        if (confirmClose) {
            document.getElementById('loadingAnimation').classList.remove('d-none');

            try {
                const response = await fetch(`${backendUrl}/close-movimento`, {
                    method: 'POST',
                    credentials: 'include', // Incluir cookies de autenticação
                });

                const result = await response.json();
                if (response.ok) {
                    alert('Movimento fechado com sucesso!');
                    loadEnvioMassaTable(); // Atualiza a tabela
                } else {
                    alert('Erro ao fechar o movimento: ' + result.error);
                }
            } catch (error) {
                alert('Erro ao fechar o movimento: ' + error.message);
            } finally {
                document.getElementById('loadingAnimation').classList.add('d-none');
            }
        }
    });

    // Função para fazer upload de arquivo
    document.getElementById("fileInput").addEventListener("change", function () {
        const formData = new FormData(document.getElementById("uploadForm"));

        // Adiciona o id_empresa ao formData (pego do localStorage após o login)
        const empresaId = localStorage.getItem('empresaId');
        //formData.append('id_empresa', empresaId);

        // Mostra a animação de carregamento
        document.getElementById('loadingAnimation').classList.remove('d-none');

        fetch(`${backendUrl}/upload`, {  // Use a URL completa do backend
            method: 'POST',
            credentials: 'include', // Necessário para enviar cookies de autenticação
            body: formData
        }).then(response => response.json())
            .then(result => {
                // Esconde a animação de carregamento
                document.getElementById('loadingAnimation').classList.add('d-none');

                if (result.success) {
                    alert("Arquivo enviado com sucesso e registros importados!");
                    loadEnvioMassaTable(); // Atualiza a tabela
                } else {
                    alert("Erro ao processar o arquivo: " + result.message);
                }
            }).catch(error => {
                // Esconde a animação de carregamento mesmo em caso de erro
                document.getElementById('loadingAnimation').classList.add('d-none');
                alert("Erro no upload: " + error);
            });
    });

    // Função para carregar e atualizar as contagens nos rótulos
    const lblEnviadoMsgEnviada = document.getElementById('lblEnviadoMsgEnviada');
    const lblErroMsgEnviada = document.getElementById('lblErroMsgEnviada');
    const lblXMLEnviado = document.getElementById('lblXMLEnviado');
    const lblXMLErro = document.getElementById('lblXMLErro');
    const lblTotal = document.getElementById('lblTotal');
    
    function updateCounts() {
        let qtdeEnviada = 0;
        let qtdeErroEnviada = 0;
        let qtdeXmlEnviado = 0;
        let qtdeXmlErro = 0;
        let qtdeTotal = 0;

        data.forEach(item => {
            if (item.enviado === 'ok') {
                qtdeEnviada++;
            } else if (item.enviado === 'erro') {
                qtdeErroEnviada++;
            }

            const numnota = item.numnota;
            const notaOk = item.nota_ok;
            const dataEmissao = item.data_emissao;
            const erroValidacao = item.erro_validacao;

            if (numnota && notaOk && dataEmissao && !erroValidacao) {
                qtdeXmlEnviado++;
            } else if (numnota && notaOk && dataEmissao && erroValidacao) {
                qtdeXmlErro++;
            }

            qtdeTotal++;
        });

        lblEnviadoMsgEnviada.innerText = `Mensagem Enviada: ${qtdeEnviada}`;
        lblErroMsgEnviada.innerText = `Mensagem Erro: ${qtdeErroEnviada}`;
        lblXMLEnviado.innerText = `XML Enviado: ${qtdeXmlEnviado}`;
        lblXMLErro.innerText = `XML Erro: ${qtdeXmlErro}`;
        lblTotal.innerText = `Total: ${qtdeTotal}`;
    }

    // Função para verificar o status do processo
    async function checkProcessStatus() {
        try {
            const response = await fetch(`${backendUrl}/process-status`, {
                method: 'GET',
                credentials: 'include'
            });

            const result = await response.json();

            if (result.active) {
                stopProcess = false; // Processo ainda ativo
                document.getElementById('play').setAttribute('disabled', true);
                document.getElementById('stop').removeAttribute('disabled');

                if (!tableUpdateInterval) {
                    console.log('atualizando tabela');
                    tableUpdateInterval = setInterval(loadEnvioMassaTable, 13000);
                }
            } else {
                stopProcess = true; // Processo inativo
                document.getElementById('play').removeAttribute('disabled');
                document.getElementById('stop').setAttribute('disabled', true);

                if (tableUpdateInterval) {
                    console.log('parando de atualizar tabela')
                    clearInterval(tableUpdateInterval);
                    tableUpdateInterval = null;
                }
            }
        } catch (error) {
            console.error('Erro ao verificar o status do processo:', error);
        }
    }

    // Chamar a função ao carregar a página
    window.addEventListener('load', checkProcessStatus);

    document.getElementById('play').addEventListener('click', async function () {
        try {
            // Verifica se já existe um processo ativo
            const statusResponse = await fetch(`${backendUrl}/process-status`, {
                method: 'GET',
                credentials: 'include',
            });

            const statusResult = await statusResponse.json();

            if (statusResult.active) {
                alert('Já existe um processo em andamento para o seu usuário.');
                document.getElementById('play').setAttribute('disabled', true);
                document.getElementById('stop').removeAttribute('disabled');
                return;
            }

            const confirmPlay = confirm('Você realmente deseja iniciar o processo?');
            if (!confirmPlay) return;

            // Desabilita o botão "Play" e habilita o botão "Stop"
            document.getElementById('play').setAttribute('disabled', true);
            document.getElementById('stop').removeAttribute('disabled');

            // Inicia a atualização periódica da tabela
            tableUpdateInterval = setInterval(() => {
                console.log('atualizando a tabela')
                loadEnvioMassaTable(); // Atualiza a tabela periodicamente
            }, 13000);


            // Aciona o backend para iniciar o processamento
            const startResponse = await fetch(`${backendUrl}/start-process`, {
                method: 'POST',
                credentials: 'include',
            });

            if (!startResponse.ok) {
                const startError = await startResponse.json();
                alert('Erro ao iniciar o processo: ' + startError.error);
                document.getElementById('play').removeAttribute('disabled');
                document.getElementById('stop').setAttribute('disabled', true);
                return;
            }
            loadEnvioMassaTable();
            clearInterval(tableUpdateInterval);

            document.getElementById('play').removeAttribute('disabled');
            document.getElementById('stop').setAttribute('disabled', true);

        } catch (error) {
            console.error('Erro ao iniciar o processo:', error);
            alert('Erro ao iniciar o processo: ' + error.message);
            document.getElementById('play').removeAttribute('disabled');
            document.getElementById('stop').setAttribute('disabled', true);
        }
    });

    // Função para atualizar a tabela detalhada
    async function metodoEnviomensagem(data) {
        try {
            // Envia o batch de mensagens para o backend
            const response = await fetch(`${backendUrl}/process-batch-messages/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ body: data }), // Envia os dados
                credentials: 'include'
            });

            // Verifica se a resposta é bem-sucedida
            if (!response.ok) {
                const errorDetails = await response.json();
                console.error('Erro ao processar o batch:', errorDetails);
                alert(`Erro no processamento: ${errorDetails.error || 'Erro desconhecido'}`);
                return;
            }

            const result = await response.json();
            console.log('Processamento concluído com sucesso:', result);

            // Sinaliza o backend para interromper o processo
            const stopResponse = await fetch(`${backendUrl}/stop-process`, {
                method: 'POST',
                credentials: 'include'
            });

            if (!stopResponse.ok) {
                console.warn('Erro ao sinalizar o backend para interromper o processo.');
            }

            stopProcess = true; // Marca o processo como parado

            // Limpa o intervalo de atualização da tabela
            clearInterval(tableUpdateInterval);
            document.getElementById('play').removeAttribute('disabled');
            document.getElementById('stop').setAttribute('disabled', true);

        } catch (error) {
            console.error('Erro ao executar o envio de mensagens:', error);
            alert(`Erro ao executar o envio de mensagens: ${error.message}`);
        }
    }

    // Função para parar o workflow
    document.getElementById('stop').addEventListener('click', async function () {
        try {
            // Aciona o backend para parar o processo
            const stopResponse = await fetch(`${backendUrl}/stop-process`, {
                method: 'POST',
                credentials: 'include',
            });

            if (!stopResponse.ok) {
                const stopError = await stopResponse.json();
                alert('Erro ao parar o processo: ' + stopError.error);
                return;
            }

            alert('Processo interrompido com sucesso!');

            // Atualiza o estado dos botões
            document.getElementById('stop').setAttribute('disabled', true);
            document.getElementById('play').removeAttribute('disabled');

            // Para a atualização periódica da tabela
            clearInterval(tableUpdateInterval);
        } catch (error) {
            console.error('Erro ao parar o processo:', error);
            alert('Erro ao parar o processo: ' + error.message);
        }
    });

});
