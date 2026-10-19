// Dados de apoio para gerar endereços e nomes fictícios no Brasil.

export interface Uf {
  sigla: string;
  codigo: string;               // código IBGE da UF (cUF)
  ceps: [number, number][];     // faixas dos 5 primeiros dígitos do CEP
  municipios: { nome: string; ibge: string }[];
}

export const UFS: Uf[] = [
  { sigla: 'RO', codigo: '11', ceps: [[76800, 76999]], municipios: [{ nome: 'Porto Velho', ibge: '1100205' }] },
  { sigla: 'AC', codigo: '12', ceps: [[69900, 69999]], municipios: [{ nome: 'Rio Branco', ibge: '1200401' }] },
  { sigla: 'AM', codigo: '13', ceps: [[69000, 69299], [69400, 69899]], municipios: [{ nome: 'Manaus', ibge: '1302603' }] },
  { sigla: 'RR', codigo: '14', ceps: [[69300, 69399]], municipios: [{ nome: 'Boa Vista', ibge: '1400100' }] },
  { sigla: 'PA', codigo: '15', ceps: [[66000, 68899]], municipios: [{ nome: 'Belém', ibge: '1501402' }] },
  { sigla: 'AP', codigo: '16', ceps: [[68900, 68999]], municipios: [{ nome: 'Macapá', ibge: '1600303' }] },
  { sigla: 'TO', codigo: '17', ceps: [[77000, 77999]], municipios: [{ nome: 'Palmas', ibge: '1721000' }] },
  { sigla: 'MA', codigo: '21', ceps: [[65000, 65999]], municipios: [{ nome: 'São Luís', ibge: '2111300' }] },
  { sigla: 'PI', codigo: '22', ceps: [[64000, 64999]], municipios: [{ nome: 'Teresina', ibge: '2211001' }] },
  { sigla: 'CE', codigo: '23', ceps: [[60000, 63999]], municipios: [{ nome: 'Fortaleza', ibge: '2304400' }] },
  { sigla: 'RN', codigo: '24', ceps: [[59000, 59999]], municipios: [{ nome: 'Natal', ibge: '2408102' }] },
  { sigla: 'PB', codigo: '25', ceps: [[58000, 58999]], municipios: [{ nome: 'João Pessoa', ibge: '2507507' }] },
  { sigla: 'PE', codigo: '26', ceps: [[50000, 56999]], municipios: [{ nome: 'Recife', ibge: '2611606' }] },
  { sigla: 'AL', codigo: '27', ceps: [[57000, 57999]], municipios: [{ nome: 'Maceió', ibge: '2704302' }] },
  { sigla: 'SE', codigo: '28', ceps: [[49000, 49999]], municipios: [{ nome: 'Aracaju', ibge: '2800308' }] },
  { sigla: 'BA', codigo: '29', ceps: [[40000, 48999]], municipios: [{ nome: 'Salvador', ibge: '2927408' }] },
  { sigla: 'MG', codigo: '31', ceps: [[30000, 39999]], municipios: [{ nome: 'Belo Horizonte', ibge: '3106200' }, { nome: 'Uberlândia', ibge: '3170206' }] },
  { sigla: 'ES', codigo: '32', ceps: [[29000, 29999]], municipios: [{ nome: 'Vitória', ibge: '3205309' }] },
  { sigla: 'RJ', codigo: '33', ceps: [[20000, 28999]], municipios: [{ nome: 'Rio de Janeiro', ibge: '3304557' }, { nome: 'Niterói', ibge: '3303302' }] },
  { sigla: 'SP', codigo: '35', ceps: [[1000, 19999]], municipios: [{ nome: 'São Paulo', ibge: '3550308' }, { nome: 'Campinas', ibge: '3509502' }, { nome: 'Santos', ibge: '3548500' }, { nome: 'São José dos Campos', ibge: '3549904' }] },
  { sigla: 'PR', codigo: '41', ceps: [[80000, 87999]], municipios: [{ nome: 'Curitiba', ibge: '4106902' }, { nome: 'Londrina', ibge: '4113700' }] },
  { sigla: 'SC', codigo: '42', ceps: [[88000, 89999]], municipios: [{ nome: 'Florianópolis', ibge: '4205407' }, { nome: 'Joinville', ibge: '4209102' }] },
  { sigla: 'RS', codigo: '43', ceps: [[90000, 99999]], municipios: [{ nome: 'Porto Alegre', ibge: '4314902' }, { nome: 'Caxias do Sul', ibge: '4305108' }] },
  { sigla: 'MS', codigo: '50', ceps: [[79000, 79999]], municipios: [{ nome: 'Campo Grande', ibge: '5002704' }] },
  { sigla: 'MT', codigo: '51', ceps: [[78000, 78899]], municipios: [{ nome: 'Cuiabá', ibge: '5103403' }] },
  { sigla: 'GO', codigo: '52', ceps: [[72800, 72999], [73700, 76799]], municipios: [{ nome: 'Goiânia', ibge: '5208707' }] },
  { sigla: 'DF', codigo: '53', ceps: [[70000, 72799], [73000, 73699]], municipios: [{ nome: 'Brasília', ibge: '5300108' }] },
];

export const UF_POR_SIGLA = new Map(UFS.map((u) => [u.sigla, u]));

export const EMPRESA_RAMOS = [
  'Comercial', 'Distribuidora', 'Indústria', 'Serviços', 'Tecnologia', 'Logística', 'Alimentos', 'Metalúrgica',
  'Transportes', 'Telecom', 'Engenharia', 'Química', 'Têxtil', 'Agropecuária', 'Energia', 'Embalagens',
];
export const EMPRESA_NOMES = [
  'Aurora', 'Horizonte', 'Atlântico', 'Serra Azul', 'Vale Verde', 'Pioneira', 'Bandeirante', 'Ipê', 'Jacarandá',
  'Cordilheira', 'Primavera', 'Estrela do Sul', 'Rio Claro', 'Nova Era', 'Cruzeiro', 'Planalto', 'Litoral',
  'Mantiqueira', 'Guarani', 'Boa Esperança', 'Monte Alto', 'Sol Nascente', 'Campos Gerais', 'Três Rios',
];
export const EMPRESA_SUFIXOS = ['Ltda', 'S.A.', 'Ltda', 'Ltda', 'S.A.'];

export const NOMES = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa',
  'Marcelo', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sabrina', 'Tiago', 'Vanessa', 'William',
];
export const SOBRENOMES = [
  'Almeida', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Fernandes', 'Gomes', 'Henriques', 'Lima', 'Machado',
  'Nogueira', 'Oliveira', 'Pereira', 'Queiroz', 'Ribeiro', 'Souza', 'Teixeira', 'Vasconcelos',
];

export const LOGRADOUROS = ['Rua', 'Avenida', 'Alameda', 'Travessa'];
export const NOMES_RUA = [
  'das Flores', 'Brasil', 'Santos Dumont', 'Sete de Setembro', 'XV de Novembro', 'dos Andradas', 'Tiradentes',
  'das Palmeiras', 'Rio Branco', 'dos Ipês', 'da Liberdade', 'das Nações', 'Industrial', 'do Comércio',
];
export const BAIRROS = ['Centro', 'Jardim América', 'Vila Nova', 'Distrito Industrial', 'Bela Vista', 'Santa Cruz', 'Boa Vista', 'Jardim Europa'];
