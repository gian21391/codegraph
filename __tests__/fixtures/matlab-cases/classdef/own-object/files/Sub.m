classdef Sub < Base
    methods
        function obj = Sub(L, varargin)
            render(L);
            L.helper();
            render(obj);
            obj.helper();
        end
        function onClick(~, src, evt)
            render(src);
            src.helper();
        end
        function onKey(this, evt)
            render(this);
        end
    end
    methods (Static)
        function s = make(a)
            render(a);
        end
    end
end
