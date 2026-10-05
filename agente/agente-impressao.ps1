# Gran Paolo - Agente de impressao
# Fica de olho nos pedidos novos e imprime sozinho: via completa no caixa, via sem endereco na cozinha.
# Uso normal: dois cliques em iniciar-agente.bat
# Teste das impressoras: powershell -ExecutionPolicy Bypass -File agente-impressao.ps1 -Teste
param(
  [switch]$Teste,
  [switch]$UmaVez,
  [string]$Config = ''
)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$pasta = $PSScriptRoot
if (-not $pasta) { $pasta = (Get-Location).Path }
if (-not $Config) { $Config = Join-Path $pasta 'config.json' }
$cfg = Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json
$arquivoSenha = Join-Path $pasta 'senha.dat'
$arquivoLog = Join-Path $pasta 'agente.log'
try { [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance) } catch {}
$enc = [System.Text.Encoding]::GetEncoding([int]$cfg.codificacao)
$L = [int]$cfg.colunas
$script:Token = $null; $script:Refresh = $null; $script:Expira = [datetime]::MinValue

function Log([string]$msg, [string]$cor = 'Gray') {
  $linha = ('{0:dd/MM HH:mm:ss}  {1}' -f (Get-Date), $msg)
  Write-Host $linha -ForegroundColor $cor
  try { Add-Content -Path $arquivoLog -Value $linha -Encoding UTF8 } catch {}
}

# ---------- impressao crua no Windows (USB / nome da impressora) ----------
if ($env:OS -eq 'Windows_NT') {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class GPRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
  public static string Send(string printerName, byte[] bytes) {
    IntPtr h; DOCINFOA di = new DOCINFOA();
    di.pDocName = "Gran Paolo pedido"; di.pDataType = "RAW";
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) return "Nao achei a impressora '" + printerName + "' no Windows (erro " + Marshal.GetLastWin32Error() + ")";
    string erro = null;
    if (StartDocPrinter(h, 1, di)) {
      if (StartPagePrinter(h)) {
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, p, bytes.Length);
        int written;
        bool ok = WritePrinter(h, p, bytes.Length, out written);
        Marshal.FreeCoTaskMem(p);
        if (!ok || written != bytes.Length) erro = "Falha ao enviar para '" + printerName + "' (erro " + Marshal.GetLastWin32Error() + ")";
        EndPagePrinter(h);
      } else { erro = "Falha ao iniciar a pagina (erro " + Marshal.GetLastWin32Error() + ")"; }
      EndDocPrinter(h);
    } else { erro = "Falha ao iniciar o documento (erro " + Marshal.GetLastWin32Error() + ")"; }
    ClosePrinter(h);
    return erro;
  }
}
"@
}

function Enviar-Impressora($destino, [byte[]]$bytes, [string]$nome) {
  switch ($destino.tipo) {
    'rede' {
      $c = New-Object System.Net.Sockets.TcpClient
      try {
        $ar = $c.BeginConnect([string]$destino.ip, [int]$destino.porta, $null, $null)
        $falhou = $false
        if (-not $ar.AsyncWaitHandle.WaitOne(5000)) { $falhou = $true } else { try { $c.EndConnect($ar) } catch { $falhou = $true } }
        if ($falhou) { throw "A impressora da $nome nao respondeu ($($destino.ip)). Veja se esta ligada e com o cabo de rede." }
        $s = $c.GetStream(); $s.Write($bytes, 0, $bytes.Length); $s.Flush()
        Start-Sleep -Milliseconds 400
      } finally { $c.Close() }
    }
    'windows' {
      $r = [GPRawPrinter]::Send([string]$destino.nome, $bytes)
      if ($r) { throw "$r. Veja se a impressora esta ligada, com papel e sem erro." }
    }
    'arquivo' {   # so para testes
      $fs = [System.IO.File]::Open([string]$destino.caminho, [System.IO.FileMode]::Append)
      try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
    }
    default { throw "Tipo de impressora invalido na config: $($destino.tipo)" }
  }
}

# ---------- montagem do papel (ESC/POS) ----------
$script:buf = $null
function Novo { $script:buf = New-Object 'System.Collections.Generic.List[byte]'; Raw 0x1B,0x40; Raw 0x1B,0x74,([byte]$cfg.paginaCodigo) }
function Raw([byte[]]$b) { $script:buf.AddRange($b) }
function Limpar([string]$s) {
  if ($null -eq $s) { return '' }
  $s = $s -replace '[\x00-\x1F\x7F]', ' '
  $s = $s.Replace([string][char]0x2022, '-').Replace([string][char]0x2014, '-').Replace([string][char]0x2013, '-')
  $s = $s.Replace([string][char]0x201C, '"').Replace([string][char]0x201D, '"').Replace([string][char]0x2018, "'").Replace([string][char]0x2019, "'").Replace([string][char]0x2026, '...')
  if ($cfg.semAcentos) { $n = $s.Normalize([Text.NormalizationForm]::FormD); $s = (($n.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' }) -join '') }
  return $s
}
function Linha([string]$t) {
  $b = $enc.GetBytes((Limpar $t))
  for ($i = 0; $i -lt $b.Length; $i++) { if ($b[$i] -lt 0x20) { $b[$i] = 0x20 } }   # nunca deixa passar byte de comando
  Raw $b; Raw 0x0A
}
function Centro { Raw 0x1B,0x61,1 }
function Esq { Raw 0x1B,0x61,0 }
$script:tamEsc = $false   # true = impressora que nao entende GS ! (usa ESC ! no lugar)
function Grande { if ($script:tamEsc) { Raw 0x1B,0x21,0x30 } else { Raw 0x1D,0x21,0x11 } }
function AltaX2 { if ($script:tamEsc) { Raw 0x1B,0x21,0x10 } else { Raw 0x1D,0x21,0x01 } }
function Normal { if ($script:tamEsc) { Raw 0x1B,0x21,0x00 } else { Raw 0x1D,0x21,0x00 } }
function Negrito([bool]$on) { if ($on) { Raw 0x1B,0x45,1 } else { Raw 0x1B,0x45,0 } }
function Traco { Linha ('-' * $L) }
function Cortar { Raw 0x0A,0x0A,0x0A; Raw 0x1D,0x56,0x42,0x00 }
function Quebrar([string]$t, [int]$larg) {
  $t = Limpar $t; $saida = @()
  while ($t.Length -gt $larg) {
    $corte = $t.LastIndexOf(' ', $larg - 1); if ($corte -lt 1) { $corte = $larg }
    $saida += $t.Substring(0, $corte).TrimEnd(); $t = $t.Substring($corte).TrimStart()
  }
  $saida += $t; return $saida
}
function ParaLinhas([string]$prefixo, [string]$t) {
  $partes = Quebrar ($prefixo + $t) $L
  foreach ($x in $partes) { Linha $x }
}
function Dinheiro($v) {
  $s = ([double]$v).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture).Replace('.', ',')
  $s = [regex]::Replace($s, '(\d)(?=(\d{3})+,)', '$1.')
  return ('R$ ' + $s)
}
function Alinhar([string]$esq, [string]$dir) {
  $esqL = @(Quebrar $esq ($L - $dir.Length - 1))
  for ($i = 0; $i -lt $esqL.Count - 1; $i++) { Linha $esqL[$i] }
  $ult = $esqL[$esqL.Count - 1]
  $esp = $L - $ult.Length - $dir.Length; if ($esp -lt 1) { $esp = 1 }
  Linha ($ult + (' ' * $esp) + $dir)
}
function Data($v) {
  if ($v -is [datetime]) { return $v.ToLocalTime() }
  return [DateTimeOffset]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime
}
function RotuloTipo($m) {
  switch ($m) { 'Drive-thru' { 'DRIVE-THRU' } 'Entrega' { 'ENTREGA' } 'Vem comer' { 'VEM COMER' } 'Retirada' { 'RETIRADA' } default { ([string]$m).ToUpper() } }
}
function Destino($m) {
  switch ($m) { 'Vem comer' { 'BANDEJA' } 'Retirada' { 'CAIXA' } default { '' } }
}

function Ticket-Cozinha($p) {
  Novo
  Centro; Grande; Negrito $true; Linha ('#' + $p.numero); Linha (RotuloTipo $p.modalidade)
  $d = Destino $p.modalidade; if ($d) { Linha ('-> ' + $d) }
  Normal; Negrito $false; Esq
  Traco
  Linha ('Cliente: ' + $p.nome)
  Linha ('Hora: ' + (Data $p.criado_em).ToString('HH:mm'))
  Traco
  Negrito $true; AltaX2
  foreach ($i in $p.itens) { $q = 1; if ($i.qtd) { $q = [int]$i.qtd }; ParaLinhas ('' + $q + 'x ') ($i.nome + ' (' + $i.tamanho + ')') }
  Normal; Negrito $false
  if ($p.obs) { Traco; Negrito $true; ParaLinhas 'OBS: ' $p.obs; Negrito $false }
  Traco; Centro; Linha 'COZINHA'; Esq
  Cortar
  return $script:buf.ToArray()
}
function Ticket-Caixa($p) {
  Novo
  Centro; Negrito $true; Linha 'GRAN PAOLO'; Negrito $false
  Grande; Negrito $true; Linha ('#' + $p.numero + ' ' + (RotuloTipo $p.modalidade)); Normal; Negrito $false
  $d = Destino $p.modalidade; if ($d) { Negrito $true; Linha ('Entregar na ' + $d); Negrito $false }
  Linha ((Data $p.criado_em).ToString('dd/MM/yyyy HH:mm')); Esq
  Traco
  Linha ('Cliente: ' + $p.nome)
  if ($p.telefone) { Linha ('WhatsApp: ' + $p.telefone) }
  if ($p.modalidade -eq 'Entrega') {
    if ($p.bairro) { Linha ('Bairro: ' + $p.bairro) }
    if ($p.endereco) { ParaLinhas 'Endereco: ' $p.endereco } else { Linha 'Endereco: (nao informado)' }
  }
  Traco
  $soma = 0.0
  foreach ($i in $p.itens) {
    $q = 1; if ($i.qtd) { $q = [int]$i.qtd }
    $sub = $q * [double]$i.precoUnit; $soma += $sub
    Alinhar ('' + $q + 'x ' + $i.nome + ' (' + $i.tamanho + ')') (Dinheiro $sub)
  }
  Traco
  if ([double]$p.taxa_entrega -gt 0) { Alinhar 'Taxa de entrega' (Dinheiro $p.taxa_entrega) }
  Negrito $true; AltaX2; Alinhar 'TOTAL' (Dinheiro $p.total); Normal; Negrito $false
  Linha ('Cobrar: ' + $p.pagamento)
  if ($p.obs) { Traco; ParaLinhas 'Obs: ' $p.obs }
  Cortar
  return $script:buf.ToArray()
}
function Ticket-Teste([string]$onde) {
  Novo
  Centro; Grande; Negrito $true; Linha 'TESTE'; Normal; Negrito $false
  Linha ('Gran Paolo - ' + $onde); Esq
  Traco
  Linha 'Acentos: acao, pizza de calabresa, feijao'
  Linha ('Acentos: ' + [string]::Join('', [char[]](0xE7,0xE3,0xE9,0xE1,0xF5,0xEA,0xED,0xFA,0xC7,0xC3,0xC9,0xE0)))
  Linha 'Moeda: R$ 1.234,56'
  Traco
  Negrito $true; Linha 'Negrito'; Negrito $false
  AltaX2; Linha 'Letra alta'; Normal
  Grande; Linha 'GRANDE'; Normal
  Linha ('Largura: ' + ('1234567890' * 5).Substring(0, $L))
  Cortar
  return $script:buf.ToArray()
}

# ---------- acesso ao Supabase ----------
function Ler-Senha([bool]$perguntar) {
  if ($env:GP_SENHA) { return $env:GP_SENHA }
  if ((Test-Path $arquivoSenha) -and -not $perguntar) {
    $sec = Get-Content $arquivoSenha | ConvertTo-SecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  }
  Write-Host ''
  $sec = Read-Host ('Senha do usuario ' + $cfg.email + ' (so e pedida esta vez)') -AsSecureString
  $sec | ConvertFrom-SecureString | Set-Content $arquivoSenha
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Guardar-Token($j) {
  $script:Token = $j.access_token; $script:Refresh = $j.refresh_token
  $script:Expira = (Get-Date).AddSeconds([int]$j.expires_in - 120)
}
function Pedir-Token([string]$grant, $corpo) {
  $r = Invoke-WebRequest -Uri ($cfg.supabaseUrl + '/auth/v1/token?grant_type=' + $grant) -Method POST -UseBasicParsing `
       -Headers @{ apikey = $cfg.chavePublica } -ContentType 'application/json' -Body ($corpo | ConvertTo-Json -Compress)
  return ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json)
}
function Entrar {
  $perguntar = $false
  for ($t = 1; $t -le 3; $t++) {
    $senha = Ler-Senha $perguntar
    try { Guardar-Token (Pedir-Token 'password' @{ email = $cfg.email; password = $senha }); Log 'Login feito.' 'Green'; return }
    catch {
      $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -eq 400 -and -not $env:GP_SENHA) { Log 'Senha nao confere. Digite de novo.' 'Yellow'; $perguntar = $true } else { throw }
    }
  }
  throw 'Nao consegui entrar. Confira o usuario e a senha no Supabase.'
}
function Garantir-Token {
  if ($script:Token -and (Get-Date) -lt $script:Expira) { return }
  if ($script:Refresh) { try { Guardar-Token (Pedir-Token 'refresh_token' @{ refresh_token = $script:Refresh }); return } catch {} }
  Entrar
}
function Http([string]$metodo, [string]$caminho, $corpo = $null, [bool]$jaTentou = $false) {
  Garantir-Token
  $p = @{ Uri = ($cfg.supabaseUrl + $caminho); Method = $metodo; UseBasicParsing = $true; ContentType = 'application/json'
          Headers = @{ apikey = $cfg.chavePublica; Authorization = ('Bearer ' + $script:Token) } }
  if ($null -ne $corpo) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Depth 6 -Compress)) }
  try {
    $r = Invoke-WebRequest @p
    $txt = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
    return (ConvertFrom-Json $txt)
  } catch {
    $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401 -and -not $jaTentou) { $script:Token = $null; return Http $metodo $caminho $corpo $true }
    throw
  }
}
function Marcar([int64]$id, [string]$via, [string]$erro = $null) {
  $c = @{ p_pedido = $id; p_via = $via }
  if ($erro) { $c.p_erro = $erro }
  Http 'POST' '/rest/v1/rpc/agente_marcar_impresso' $c | Out-Null
}

# ---------- programa principal ----------
if ($Teste) {
  Log 'TESTE: vou imprimir uma folha de teste em cada impressora.' 'Cyan'
  foreach ($par in @(@('cozinha', $cfg.cozinha), @('caixa', $cfg.caixa))) {
    try { $script:tamEsc = [bool]$par[1].tamanhoEsc; Enviar-Impressora $par[1] (Ticket-Teste $par[0]) $par[0]; Log ('Teste enviado: ' + $par[0]) 'Green' }
    catch { Log ('FALHOU (' + $par[0] + '): ' + $_.Exception.Message) 'Red' }
  }
  if (-not $UmaVez) { Write-Host ''; Read-Host 'Confira os papeis e aperte Enter para fechar' | Out-Null }
  exit 0
}

Log 'Agente de impressao Gran Paolo iniciado. Deixe esta janela aberta (pode minimizar).' 'Cyan'
Log ('Cozinha: ' + $(if ($cfg.cozinha.tipo -eq 'rede') { $cfg.cozinha.ip } else { $cfg.cozinha.nome }) + '   Caixa: ' + $(if ($cfg.caixa.tipo -eq 'windows') { $cfg.caixa.nome } else { $cfg.caixa.tipo })) 'Gray'
$ultimoErro = @{}      # id -> mensagem (so avisa o painel quando muda)
$proxima = @{}         # id+via -> quando tentar de novo
$ciclo = 0
while ($true) {
  try {
    $desde = (Get-Date).ToUniversalTime().AddMinutes(-[int]$cfg.minutosParaTras).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $q = '/rest/v1/pedidos?select=*&loja_id=eq.' + $cfg.loja + '&status=in.(novo,cozinha,pronto)' +
         '&or=(impresso_cozinha_em.is.null,impresso_caixa_em.is.null)&criado_em=gte.' + $desde + '&order=criado_em.asc'
    $pend = @(Http 'GET' $q)
    foreach ($p in $pend) {
      if ($null -eq $p -or -not $p.id) { continue }
      foreach ($via in @('cozinha', 'caixa')) {
        $campo = if ($via -eq 'cozinha') { $p.impresso_cozinha_em } else { $p.impresso_caixa_em }
        if ($campo) { continue }
        $chave = [string]$p.id + $via
        if ($proxima.ContainsKey($chave) -and (Get-Date) -lt $proxima[$chave]) { continue }
        try {
          if ($via -eq 'cozinha') { $script:tamEsc = [bool]$cfg.cozinha.tamanhoEsc; Enviar-Impressora $cfg.cozinha (Ticket-Cozinha $p) 'cozinha' }
          else { $script:tamEsc = [bool]$cfg.caixa.tamanhoEsc; Enviar-Impressora $cfg.caixa (Ticket-Caixa $p) 'caixa' }
          Marcar $p.id $via
          $proxima.Remove($chave); $ultimoErro.Remove($chave)
          Log ('Impresso: #' + $p.numero + ' ' + $p.nome + ' (' + $via + ')') 'Green'
        } catch {
          $msg = $_.Exception.Message; if ($msg.Length -gt 150) { $msg = $msg.Substring(0, 150) }
          $proxima[$chave] = (Get-Date).AddSeconds(30)
          Log ('ERRO ao imprimir #' + $p.numero + ' (' + $via + '): ' + $msg) 'Red'
          if ($ultimoErro[$chave] -ne $msg) { $ultimoErro[$chave] = $msg; try { Marcar $p.id $via ($via + ': ' + $msg) } catch {} }
        }
      }
    }
  } catch {
    Log ('Sem conexao com o sistema (' + $_.Exception.Message + '). Tentando de novo...') 'Yellow'
  }
  if ($UmaVez) { break }
  Start-Sleep -Seconds 4
}
