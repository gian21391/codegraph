function gui(h)
uicontrol('Style', 'pushbutton', 'Callback', @onPress);
set(h, 'WindowButtonMotionFcn', {@onMove, 2});
h.CloseRequestFcn = @onClose;
end
