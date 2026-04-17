/*
 * Library for containing some standard functions for working with web related stuff.
 * Can be shared across the client- and server code.
 */

/**
 * Gets the cookies from a string containing cookies.
 *
 * @param name
 * @param cookies
 * @returns
 */
export const getCookie = (
  name: string,
  cookies: string,
): string | undefined => {
  const value = `; ${cookies}`;
  const parts = value.split(`; ${name}=`);

  if (parts.length === 2) {
    return parts.pop()?.split(";").shift();
  }

  return undefined;
};
