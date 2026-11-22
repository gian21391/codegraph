function useAcc(h)
a = Acct(1);
a = set(a, 'v', 2);
v = get(a, 'v');
set(h, 'Visible', 'off');
notdefined(h);
end
