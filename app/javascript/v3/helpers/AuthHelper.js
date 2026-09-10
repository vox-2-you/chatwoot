import Cookies from 'js-cookie';
import { DEFAULT_REDIRECT_URL } from 'dashboard/constants/globals';
import { frontendURL } from 'dashboard/helper/URLHelper';

export const hasAuthCookie = () => {
  return !!Cookies.get('cw_d_session_info');
};

const getSSOAccountPath = ({ ssoAccountId, user }) => {
  const { accounts = [], account_id = null } = user || {};
  const ssoAccount = accounts.find(
    account => account.id === Number(ssoAccountId)
  );
  let accountPath = '';
  if (ssoAccount) {
    accountPath = `accounts/${ssoAccountId}`;
  } else if (accounts.length) {
    // If the account id is not found, redirect to the first account
    const accountId = account_id || accounts[0].id;
    accountPath = `accounts/${accountId}`;
  }
  return accountPath;
};

const capitalize = str =>
  str
    .split(/[._-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const getCredentialsFromEmail = email => {
  const [localPart, domain] = email.split('@');
  const namePart = localPart.split('+')[0];
  return {
    fullName: capitalize(namePart),
    accountName: capitalize(domain.split('.')[0]),
  };
};

/**
 * Caminho interno pedido no link de SSO, se for seguro.
 *
 * Só aceita caminho relativo dentro do painel: sem esquema e sem `//` no começo, senão o
 * parâmetro viraria redirecionamento aberto — bastaria mandar `//site.com` para levar quem
 * clica no link para fora, com a aparência de um endereço nosso.
 */
const safeSSORedirectPath = ssoRedirectPath => {
  if (!ssoRedirectPath) return null;
  if (!ssoRedirectPath.startsWith('/') || ssoRedirectPath.startsWith('//')) {
    return null;
  }
  return ssoRedirectPath;
};

export const getLoginRedirectURL = ({
  ssoAccountId,
  ssoConversationId,
  ssoRedirectPath,
  user,
}) => {
  const redirectPath = safeSSORedirectPath(ssoRedirectPath);
  if (redirectPath) return redirectPath;

  const accountPath = getSSOAccountPath({ ssoAccountId, user });
  if (accountPath) {
    if (ssoConversationId) {
      return frontendURL(`${accountPath}/conversations/${ssoConversationId}`);
    }
    return frontendURL(`${accountPath}/dashboard`);
  }
  return DEFAULT_REDIRECT_URL;
};
