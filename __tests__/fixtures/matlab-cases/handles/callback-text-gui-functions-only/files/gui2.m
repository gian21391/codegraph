function gui2(h, k, fn)
uimenu('Label', 'Callback', 'Callback', 'go_menu');
s = struct('name', 'Callback', 'value', 'go_two');
cb = 'go_lower';
set(h, 'callback', cb);
myfun('Callback', 'go_not');
uicontrol('Callback', ['go_hole(' num2str(k) ')']);
uicontrol('Callback', [fn '(1)']);
end
